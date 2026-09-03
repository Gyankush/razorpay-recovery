import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { webhookEvents, paymentAttempts } from "@/db/schema";
import { eq } from "drizzle-orm";
import { verifyWebhookSignature } from "@/lib/razorpay";
import {
  mapRazorpayEventToCanonicalState,
  updatePaymentState,
  openOrUpdateCase,
  ensureOrderForWebhook,
} from "@/lib/domain/normalizer";
import { normalizeCurrency } from "@/lib/http";

const MAX_WEBHOOK_BYTES = 1_000_000; // 1 MB

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();
    if (rawBody.length > MAX_WEBHOOK_BYTES) {
      console.warn(
        `Webhook rejected: body too large (${rawBody.length} bytes)`
      );
      return NextResponse.json(
        { error: "Payload too large" },
        { status: 413 }
      );
    }

    const signature = req.headers.get("x-razorpay-signature");
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

    if (!secret) {
      console.error(
        "Missing RAZORPAY_WEBHOOK_SECRET. Please add RAZORPAY_WEBHOOK_SECRET to your .env.local file."
      );
      return NextResponse.json(
        { error: "Webhook secret is not configured on server" },
        { status: 401 }
      );
    }

    if (!signature || !verifyWebhookSignature(rawBody, signature, secret)) {
      console.warn("Webhook rejected: Invalid signature.");
      return NextResponse.json(
        { error: "Invalid signature" },
        { status: 401 }
      );
    }

    // Extract provider event ID from header or parsed body.
    // When Razorpay omits every identifier, derive a deterministic id from
    // the body hash so redeliveries still dedupe instead of duplicating.
    let parsedBody: Record<string, any> = {};
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      // rawBody is not valid JSON
    }

    const eventIdHeader = req.headers.get("x-razorpay-event-id");
    const providerEventId =
      eventIdHeader ||
      parsedBody?.event_id ||
      parsedBody?.id ||
      `evt_hash_${crypto.createHash("sha256").update(rawBody).digest("hex").slice(0, 32)}`;

    const eventType =
      parsedBody?.event ||
      parsedBody?.event_type ||
      "unknown";

    // 1. Attempt durable & idempotent insert into webhook_events
    try {
      await db.insert(webhookEvents).values({
        providerEventId,
        eventType,
        rawBody,
        signatureValid: true,
        processed: false,
      });

      console.log(`[Webhook Receiver] Stored event ${providerEventId} (${eventType})`);
    } catch (insertError: any) {
      // Check for PostgreSQL unique constraint violation (code 23505)
      const isUniqueViolation =
        insertError?.code === "23505" ||
        insertError?.message?.includes("unique") ||
        insertError?.message?.includes("duplicate key");

      if (isUniqueViolation) {
        console.log(`Duplicate event skipped: ${providerEventId}`);
        return NextResponse.json(
          { received: true, status: "skipped", message: "Duplicate event skipped" },
          { status: 200 }
        );
      }

      console.error("Database insert error on webhook event:", insertError);
      return NextResponse.json(
        { error: "Failed to store webhook event in database" },
        { status: 500 }
      );
    }

    // 2. Normalization & Case Processing
    try {
      const canonicalState = mapRazorpayEventToCanonicalState(eventType);
      const paymentEntity = parsedBody?.payload?.payment?.entity;

      if (paymentEntity) {
        const providerPaymentId = paymentEntity.id;
        if (!providerPaymentId) {
          // Stored above; 200 avoids a Razorpay retry storm for a payload
          // we can never normalize. processed stays false for forensics.
          return NextResponse.json(
            { received: true, status: "stored_unprocessable", eventId: providerEventId },
            { status: 200 }
          );
        }

        const externalOrderId =
          paymentEntity.order_id ||
          parsedBody?.payload?.order?.entity?.id ||
          `order_ext_${providerPaymentId}`;

        const rawAmount = Number(paymentEntity.amount);
        if (!Number.isFinite(rawAmount) || rawAmount < 0) {
          return NextResponse.json(
            { received: true, status: "stored_unprocessable", eventId: providerEventId },
            { status: 200 }
          );
        }
        const amount = Math.floor(rawAmount);
        const currency = normalizeCurrency(paymentEntity.currency, "USD");
        const errorCode = paymentEntity.error_code || null;
        const errorDescription =
          paymentEntity.error_description ||
          paymentEntity.error_reason ||
          null;

        // Ensure parent order exists in database
        const order = await ensureOrderForWebhook(externalOrderId, amount, currency);

        // Update existing attempt or insert new attempt
        let attempt = await updatePaymentState(
          providerPaymentId,
          canonicalState,
          errorCode,
          errorDescription
        );

        if (!attempt) {
          const [createdAttempt] = await db
            .insert(paymentAttempts)
            .values({
              orderId: order.id,
              providerPaymentId,
              status: canonicalState,
              errorCode,
              errorDescription,
            })
            .onConflictDoNothing({
              target: paymentAttempts.providerPaymentId,
            })
            .returning();
          attempt =
            createdAttempt ??
            (
              await db
                .select()
                .from(paymentAttempts)
                .where(eq(paymentAttempts.providerPaymentId, providerPaymentId))
                .limit(1)
            )[0] ??
            null;
        }

        // Open a case only when the stored state is genuinely failed —
        // a stale `failed` redelivery must not reopen a captured payment.
        if (attempt && canonicalState === "failed" && attempt.status === "failed") {
          const reason =
            errorDescription || errorCode || "Payment failed at gateway";
          await openOrUpdateCase(order.id, attempt.id, reason);
        }

        // Mark webhook event as processed
        await db
          .update(webhookEvents)
          .set({ processed: true })
          .where(eq(webhookEvents.providerEventId, providerEventId));
      } else if (eventType.startsWith("refund.")) {
        // Best-effort refund handling across Razorpay payload shapes.
        const refundEntity =
          parsedBody?.payload?.refund?.entity ??
          parsedBody?.payload?.payment?.entity;
        const refundPaymentId =
          refundEntity?.payment_id ?? refundEntity?.id ?? null;
        if (refundPaymentId) {
          await updatePaymentState(
            String(refundPaymentId),
            "refunded",
            refundEntity?.error_code ?? "REFUND_PROCESSED",
            refundEntity?.error_description ?? "Refund processed at gateway"
          );
          await db
            .update(webhookEvents)
            .set({ processed: true })
            .where(eq(webhookEvents.providerEventId, providerEventId));
        } else {
          console.warn(
            `[Webhook Receiver] refund event ${providerEventId} has no identifiable payment; leaving unprocessed for manual review`
          );
        }
      } else {
        // Honest signal: stored but not yet actionable. A reconciler sweep
        // should pick up processed=false rows — never silently claim done.
        console.warn(
          `[Webhook Receiver] event ${providerEventId} (${eventType}) stored without a payment entity; leaving unprocessed`
        );
      }
    } catch (normalizerError) {
      console.error("Error during event normalization/case engine:", normalizerError);
      // We do not fail the 200 response to Razorpay because the event is safely stored in webhook_events
    }

    return NextResponse.json(
      { received: true, status: "stored", eventId: providerEventId },
      { status: 200 }
    );
  } catch (error) {
    console.error("Unexpected error in Razorpay webhook handler:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
