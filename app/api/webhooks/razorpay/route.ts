import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { webhookEvents } from "@/db/schema";
import { verifyWebhookSignature } from "@/lib/razorpay";
import {
  resolveWebhookSecret,
  processPaymentWebhook,
} from "@/lib/domain/webhook-processor";

const MAX_WEBHOOK_BYTES = 1_000_000; // 1 MB

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();
    if (rawBody.length > MAX_WEBHOOK_BYTES) {
      console.warn(`Webhook rejected: body too large (${rawBody.length} bytes)`);
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    }

    const signature = req.headers.get("x-razorpay-signature");

    let parsedBody: Record<string, any> = {};
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      // rawBody is not valid JSON
    }

    // Multi-merchant routing: the owning merchant's own secret verifies its
    // events (matched by payload account_id); global env is the fallback.
    const { secret } = await resolveWebhookSecret(parsedBody);

    if (!secret) {
      console.error("Missing webhook secret for this merchant (and no global fallback).");
      return NextResponse.json(
        { error: "Webhook secret is not configured on server" },
        { status: 401 }
      );
    }

    if (!signature || !verifyWebhookSignature(rawBody, signature, secret)) {
      console.warn("Webhook rejected: Invalid signature.");
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    // Deterministic event id so redeliveries dedupe instead of duplicating.
    const eventIdHeader = req.headers.get("x-razorpay-event-id");
    const providerEventId =
      eventIdHeader ||
      parsedBody?.event_id ||
      parsedBody?.id ||
      `evt_hash_${crypto.createHash("sha256").update(rawBody).digest("hex").slice(0, 32)}`;

    const eventType = parsedBody?.event || parsedBody?.event_type || "unknown";

    // 1. Durable & idempotent insert
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

    // 2. Normalize (shared with the missed-webhook sweeper)
    try {
      const outcome = await processPaymentWebhook(
        { providerEventId, eventType, rawBody },
        parsedBody
      );
      return NextResponse.json(
        { received: true, status: outcome === "processed" ? "stored" : outcome, eventId: providerEventId },
        { status: 200 }
      );
    } catch (normalizerError) {
      console.error("Error during event normalization/case engine:", normalizerError);
      return NextResponse.json(
        { received: true, status: "stored", eventId: providerEventId },
        { status: 200 }
      );
    }
  } catch (error) {
    console.error("Unexpected error in Razorpay webhook handler:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
