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

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();
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

    // Extract provider event ID from header or parsed body
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
      `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

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
        const externalOrderId =
          paymentEntity.order_id ||
          parsedBody?.payload?.order?.entity?.id ||
          `order_ext_${providerPaymentId}`;

        const amount = Number(paymentEntity.amount) || 0;
        const currency = paymentEntity.currency || "USD";
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
            .returning();
          attempt = createdAttempt;
        }

        // If payment failed, open or update a payment case
        if (canonicalState === "failed") {
          const reason =
            errorDescription || errorCode || "Payment failed at gateway";
          await openOrUpdateCase(order.id, attempt.id, reason);
        }

        // Mark webhook event as processed
        await db
          .update(webhookEvents)
          .set({ processed: true })
          .where(eq(webhookEvents.providerEventId, providerEventId));
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
