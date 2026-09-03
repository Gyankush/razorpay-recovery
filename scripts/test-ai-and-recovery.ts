import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();

import { diagnosePaymentFailure } from "../lib/ai/diagnose";
import { createRecoveryPaymentLink } from "../lib/connectors/razorpay";
import { db } from "../db";
import { merchants, orders, paymentCases, recoveryActions } from "../db/schema";
import { eq } from "drizzle-orm";

async function main() {
  console.log("=== 1. Testing AI Diagnostic Rule Engine ===");

  // Scenario A: 3DS Authentication Failure
  const diag3DS = diagnosePaymentFailure({
    errorCode: "BAD_REQUEST_ERROR",
    errorDescription: "3D-Secure authentication was not completed by the cardholder",
    currency: "USD",
    amount: 4900,
  });
  console.log(`✓ 3DS Category: ${diag3DS.category}, Confidence: ${diag3DS.confidence}, Action: ${diag3DS.recommended_action}`);
  if (diag3DS.category !== "customer_action" || diag3DS.recommended_action !== "send_alternate_payment_link") {
    throw new Error("Diagnosis for 3DS failed!");
  }
  if (!diag3DS.do_not_do.includes("blind_retry_same_card")) {
    throw new Error("Missing do_not_do guardrail for 3DS!");
  }

  // Scenario B: Risk / Fraud Block
  const diagRisk = diagnosePaymentFailure({
    errorCode: "TRANSACTION_RISK_BLOCKED",
    errorDescription: "High risk score flagged by gateway",
    currency: "USD",
    amount: 15000,
  });
  console.log(`✓ Risk Category: ${diagRisk.category}, Action: ${diagRisk.recommended_action}`);
  if (diagRisk.category !== "risk_block" || diagRisk.recommended_action !== "escalate_support") {
    throw new Error("Diagnosis for Risk failed!");
  }

  // Scenario C: Transient Network Timeout
  const diagTimeout = diagnosePaymentFailure({
    errorCode: "GATEWAY_TIMEOUT",
    errorDescription: "Connection timed out with issuing bank",
    currency: "USD",
  });
  console.log(`✓ Transient Category: ${diagTimeout.category}, Action: ${diagTimeout.recommended_action}`);
  if (diagTimeout.category !== "transient" || diagTimeout.recommended_action !== "cooldown_retry") {
    throw new Error("Diagnosis for Timeout failed!");
  }

  console.log("\n=== 2. Testing Recovery Action Executor & Idempotency ===");
  // Setup dummy order and open case
  let merchant = (await db.select().from(merchants).limit(1))[0];
  if (!merchant) {
    const [newM] = await db.insert(merchants).values({ name: "Demo Merchant", mode: "test" }).returning();
    merchant = newM;
  }

  const [testOrder] = await db.insert(orders).values({
    merchantId: merchant.id,
    externalOrderId: `ord_rec_test_${Date.now()}`,
    amount: 4900,
    currency: "USD",
    status: "failed",
  }).returning();

  const [testCase] = await db.insert(paymentCases).values({
    orderId: testOrder.id,
    status: "open",
    failureCategory: "customer_action",
    confidence: "0.88",
    plainExplanation: "3DS Drop-off",
    recommendedAction: "send_alternate_payment_link",
  }).returning();

  console.log(`✓ Created test open case: ID=${testCase.id}`);

  // First Execution
  const idempotencyKey = `idemp_key_test_${Date.now()}`;
  console.log(`Executing recovery with idempotency key: ${idempotencyKey}`);
  const result1 = await createRecoveryPaymentLink(
    testCase.id,
    testOrder.amount,
    testOrder.currency,
    idempotencyKey,
    "lead_operator"
  );

  console.log(`✓ First Execution Result: Success=${result1.success}, Link=${result1.payment_link_url}`);
  if (!result1.success || !result1.payment_link_url) {
    throw new Error("createRecoveryPaymentLink failed on first execution!");
  }

  // Verify Case Status in Database is now 'resolved'
  const [updatedCase] = await db.select().from(paymentCases).where(eq(paymentCases.id, testCase.id));
  console.log(`✓ Case status in DB: ${updatedCase.status}`);
  if (updatedCase.status !== "resolved") {
    throw new Error("Case was not marked resolved!");
  }

  // Idempotent Second Execution with identical idempotencyKey
  console.log(`Testing duplicate execution with identical key: ${idempotencyKey}`);
  const result2 = await createRecoveryPaymentLink(
    testCase.id,
    testOrder.amount,
    testOrder.currency,
    idempotencyKey,
    "lead_operator"
  );

  console.log(`✓ Second Execution Result: already_existed=${result2.already_existed}, ActionID=${result2.action.id}`);
  if (!result2.already_existed) {
    throw new Error("Idempotency failed: second call did not detect existing action!");
  }
  if (result2.action.id !== result1.action.id) {
    throw new Error("Idempotency failed: different action IDs returned!");
  }

  // Verify total count in recoveryActions table for this key is exactly 1
  const actionsCount = await db
    .select()
    .from(recoveryActions)
    .where(eq(recoveryActions.idempotencyKey, idempotencyKey));
  console.log(`✓ Total actions with key ${idempotencyKey}: ${actionsCount.length}`);
  if (actionsCount.length !== 1) {
    throw new Error(`Expected exactly 1 action record, found ${actionsCount.length}!`);
  }

  console.log("\n🎉 All AI Diagnostic & Recovery Executor tests passed with 100% success!");
  process.exit(0);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
