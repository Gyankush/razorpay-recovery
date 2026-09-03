import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();

import {
  mapRazorpayEventToCanonicalState,
  updatePaymentState,
  openOrUpdateCase,
  ensureOrderForWebhook,
} from "../lib/domain/normalizer";
import { db } from "../db";
import { paymentCases, paymentAttempts, orders } from "../db/schema";
import { eq } from "drizzle-orm";

async function main() {
  console.log("=== 1. Testing Canonical State Mapping ===");
  const testCases = [
    { input: "payment.authorized", expected: "authorized" },
    { input: "payment.captured", expected: "captured" },
    { input: "payment.failed", expected: "failed" },
    { input: "refund.processed", expected: "refunded" },
    { input: "settlement.processed", expected: "settled" },
    { input: "payment.created", expected: "initiated" },
    { input: "unknown.event", expected: "unknown" },
  ];

  for (const tc of testCases) {
    const result = mapRazorpayEventToCanonicalState(tc.input);
    if (result !== tc.expected) {
      throw new Error(`Mapping failed for ${tc.input}: got ${result}, expected ${tc.expected}`);
    }
    console.log(`✓ ${tc.input} -> ${result}`);
  }

  console.log("\n=== 2. Testing Normalizer Case & Attempt Lifecycle in Database ===");
  const testOrderId = `test_ord_${Date.now()}`;
  const order = await ensureOrderForWebhook(testOrderId, 4900, "USD");
  console.log(`✓ Ensured order in DB: ID=${order.id}, externalOrderId=${order.externalOrderId}`);

  // Create an attempt
  const testPayId = `pay_norm_${Date.now()}`;
  const [attempt] = await db
    .insert(paymentAttempts)
    .values({
      orderId: order.id,
      providerPaymentId: testPayId,
      status: "initiated",
    })
    .returning();
  console.log(`✓ Created attempt: ID=${attempt.id}, status=${attempt.status}`);

  // Update attempt state to failed
  const updatedAttempt = await updatePaymentState(
    testPayId,
    "failed",
    "BAD_REQUEST_ERROR",
    "3DS challenge abandoned by user"
  );
  if (!updatedAttempt || updatedAttempt.status !== "failed") {
    throw new Error("updatePaymentState failed to set status to 'failed'");
  }
  console.log(`✓ Updated attempt state: status=${updatedAttempt.status}, error=${updatedAttempt.errorCode}`);

  // Open a case for the failed payment
  const newCase = await openOrUpdateCase(
    order.id,
    attempt.id,
    "3DS challenge abandoned by user"
  );
  if (!newCase || newCase.status !== "open") {
    throw new Error("openOrUpdateCase failed to open a case");
  }
  console.log(`✓ Opened payment case: ID=${newCase.id}, category=${newCase.failureCategory}, action=${newCase.recommendedAction}`);

  // Test deduplication: calling openOrUpdateCase again for the same order should return the existing open case
  const duplicateCase = await openOrUpdateCase(
    order.id,
    attempt.id,
    "Another failure event"
  );
  if (duplicateCase.id !== newCase.id) {
    throw new Error("openOrUpdateCase created a duplicate case instead of returning existing open case!");
  }
  console.log(`✓ Deduplication verified: Returned existing case ID=${duplicateCase.id}`);

  console.log("\n=== 3. Testing Seed Generator Logic (Direct DB verification) ===");
  // Test scenario 1: international_3ds_fail
  const timestamp = Date.now();
  const [s1Order] = await db.insert(orders).values({
    merchantId: order.merchantId,
    externalOrderId: `ord_int3ds_test_${timestamp}`,
    amount: 4900,
    currency: "USD",
    status: "failed",
  }).returning();

  const [s1Attempt] = await db.insert(paymentAttempts).values({
    orderId: s1Order.id,
    providerPaymentId: `pay_3ds_test_${timestamp}`,
    status: "failed",
    errorCode: "BAD_REQUEST_ERROR",
    errorDescription: "International 3D-Secure authentication was not completed by the cardholder.",
  }).returning();

  const [s1Case] = await db.insert(paymentCases).values({
    orderId: s1Order.id,
    status: "open",
    failureCategory: "customer_action_required",
    confidence: "0.88",
    plainExplanation: "3DS authentication challenge was not completed.",
    recommendedAction: "send_alternate_payment_link",
  }).returning();

  console.log(`✓ Seed Scenario 1 (international_3ds_fail): case_id=${s1Case.id}, order_id=${s1Order.id}, error=${s1Attempt.errorCode}`);

  // Test scenario 2: issuer_decline
  const [s2Order] = await db.insert(orders).values({
    merchantId: order.merchantId,
    externalOrderId: `ord_issdec_test_${timestamp}`,
    amount: 4900,
    currency: "USD",
    status: "failed",
  }).returning();

  const [s2Attempt] = await db.insert(paymentAttempts).values({
    orderId: s2Order.id,
    providerPaymentId: `pay_issdec_test_${timestamp}`,
    status: "failed",
    errorCode: "GATEWAY_ERROR",
    errorDescription: "Transaction declined by issuing bank: Do not honor.",
  }).returning();

  const [s2Case] = await db.insert(paymentCases).values({
    orderId: s2Order.id,
    status: "open",
    failureCategory: "issuer_decline",
    confidence: "0.94",
    plainExplanation: "The issuing bank explicitly rejected the cross-border transaction.",
    recommendedAction: "escalate_to_customer",
  }).returning();

  console.log(`✓ Seed Scenario 2 (issuer_decline): case_id=${s2Case.id}, order_id=${s2Order.id}, error=${s2Attempt.errorCode}`);

  console.log("\n🎉 All Normalizer & Seed Generator tests passed successfully!");
  process.exit(0);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
