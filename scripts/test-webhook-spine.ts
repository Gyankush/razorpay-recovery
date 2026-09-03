import crypto from "crypto";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();

import { verifyWebhookSignature } from "../lib/razorpay";
import { db } from "../db";
import { webhookEvents } from "../db/schema";
import { eq } from "drizzle-orm";

async function main() {
  console.log("--- 1. Testing Signature Verification ---");
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET || "test_webhook_secret_payrescue";
  const payload = JSON.stringify({
    entity: "event",
    account_id: "acc_demo_test",
    event: "payment.failed",
    contains: ["payment"],
    payload: {
      payment: {
        entity: {
          id: "pay_test_failed_123",
          amount: 4900,
          currency: "USD",
          status: "failed",
          error_code: "BAD_REQUEST_ERROR",
          error_description: "3DS verification was not completed by the user.",
        },
      },
    },
    created_at: Math.floor(Date.now() / 1000),
  });

  const validSignature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  const invalidSignature = "deadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678";

  const isValid = verifyWebhookSignature(payload, validSignature, secret);
  const isInvalidRejected = !verifyWebhookSignature(payload, invalidSignature, secret);

  console.log(`✓ Valid signature verified: ${isValid}`);
  console.log(`✓ Invalid signature rejected: ${isInvalidRejected}`);

  if (!isValid || !isInvalidRejected) {
    throw new Error("Signature verification failed test!");
  }

  console.log("\n--- 2. Testing Database Idempotent Storage ---");
  const testEventId = `evt_test_${Date.now()}`;

  // First insert
  console.log(`Attempting initial insert of event: ${testEventId}`);
  await db.insert(webhookEvents).values({
    providerEventId: testEventId,
    eventType: "payment.failed",
    rawBody: payload,
    signatureValid: true,
    processed: false,
  });
  console.log("✓ Initial insert succeeded!");

  // Duplicate insert test
  console.log(`Attempting duplicate insert of event: ${testEventId}`);
  let duplicateHandled = false;
  try {
    await db.insert(webhookEvents).values({
      providerEventId: testEventId,
      eventType: "payment.failed",
      rawBody: payload,
      signatureValid: true,
      processed: false,
    });
  } catch (error: any) {
    const isUniqueViolation =
      error?.code === "23505" ||
      error?.message?.includes("unique") ||
      error?.message?.includes("duplicate key");

    if (isUniqueViolation) {
      console.log(`✓ Duplicate event skipped as expected (unique violation caught)!`);
      duplicateHandled = true;
    } else {
      throw error;
    }
  }

  if (!duplicateHandled) {
    throw new Error("Duplicate insert was not caught by unique constraint!");
  }

  // Verify record in database
  const record = await db
    .select()
    .from(webhookEvents)
    .where(eq(webhookEvents.providerEventId, testEventId));

  console.log(`✓ Verified record stored in Supabase: ID=${record[0]?.id}, event_type=${record[0]?.eventType}, signature_valid=${record[0]?.signatureValid}`);

  console.log("\n🎉 Webhook Event Spine verification complete and all tests passed!");
  process.exit(0);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
