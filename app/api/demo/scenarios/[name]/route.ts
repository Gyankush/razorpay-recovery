import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import {
  merchants,
  orders,
  paymentAttempts,
  paymentCases,
  settlements,
  reconItems,
  webhookEvents,
} from "@/db/schema";
import { logAuditEvent } from "@/lib/domain/audit";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: { name: string } }
) {
  return handleScenario(params?.name?.toLowerCase());
}

export async function POST(
  request: NextRequest,
  { params }: { params: { name: string } }
) {
  return handleScenario(params?.name?.toLowerCase());
}

async function handleScenario(scenarioName?: string) {
  try {
    const timestamp = Date.now();

    // Ensure default merchant exists
    let merchant = (await db.select().from(merchants).limit(1))[0];
    if (!merchant) {
      const [newMerchant] = await db
        .insert(merchants)
        .values({
          name: "SaaSify Global Inc.",
          mode: "test",
          timezone: "Asia/Kolkata",
          policyId: "strict_anti_duplicate_v1",
        })
        .returning();
      merchant = newMerchant;
    }

    switch (scenarioName) {
      // -------------------------------------------------------------
      // 1. International 3DS Incomplete
      // -------------------------------------------------------------
      case "international_3ds_fail": {
        const [order] = await db.insert(orders).values({
          merchantId: merchant.id,
          externalOrderId: `ord_3ds_${timestamp}`,
          amount: 4900,
          currency: "USD",
          status: "failed",
        }).returning();

        const [attempt] = await db.insert(paymentAttempts).values({
          orderId: order.id,
          providerPaymentId: `pay_3ds_${timestamp}`,
          status: "failed",
          method: "card",
          country: "US",
          errorCode: "BAD_REQUEST_ERROR",
          errorDescription: "3DS authentication was not completed by the cardholder.",
        }).returning();

        const [newCase] = await db.insert(paymentCases).values({
          orderId: order.id,
          status: "open",
          failureCategory: "customer_action",
          confidence: "0.88",
          plainExplanation: "Customer checkout dropped off during the 3D-Secure authentication challenge.",
          recommendedAction: "send_alternate_payment_link",
        }).returning();

        await logAuditEvent({ actor: "demo_seeder", action: "scenario_seeded", entity: "payment_case", entityId: newCase.id });
        return NextResponse.json({ success: true, case_id: newCase.id, scenario: scenarioName, order_id: order.id });
      }

      // -------------------------------------------------------------
      // 2. Issuer Decline (Cross-border disabled)
      // -------------------------------------------------------------
      case "issuer_decline": {
        const [order] = await db.insert(orders).values({
          merchantId: merchant.id,
          externalOrderId: `ord_issdec_${timestamp}`,
          amount: 7900,
          currency: "USD",
          status: "failed",
        }).returning();

        const [attempt] = await db.insert(paymentAttempts).values({
          orderId: order.id,
          providerPaymentId: `pay_issdec_${timestamp}`,
          status: "failed",
          method: "card",
          country: "GB",
          errorCode: "GATEWAY_ERROR",
          errorDescription: "Transaction declined by issuing bank: Do not honor. Cross-border disabled.",
        }).returning();

        const [newCase] = await db.insert(paymentCases).values({
          orderId: order.id,
          status: "open",
          failureCategory: "customer_action",
          confidence: "0.92",
          plainExplanation: "The issuing bank explicitly declined the cross-border charge without capturing funds.",
          recommendedAction: "send_alternate_payment_link",
        }).returning();

        return NextResponse.json({ success: true, case_id: newCase.id, scenario: scenarioName, order_id: order.id });
      }

      // -------------------------------------------------------------
      // 3. Bank Timeout Late Success
      // -------------------------------------------------------------
      case "bank_timeout_late_success": {
        const [order] = await db.insert(orders).values({
          merchantId: merchant.id,
          externalOrderId: `ord_timeout_${timestamp}`,
          amount: 5500,
          currency: "EUR",
          status: "completed",
        }).returning();

        // 1st attempt timed out
        await db.insert(paymentAttempts).values({
          orderId: order.id,
          providerPaymentId: `pay_att1_${timestamp}`,
          status: "failed",
          errorCode: "GATEWAY_TIMEOUT",
          errorDescription: "Initial authorization timed out waiting for rail response.",
        });

        // 2nd attempt captured late
        const [attempt2] = await db.insert(paymentAttempts).values({
          orderId: order.id,
          providerPaymentId: `pay_att2_${timestamp}`,
          status: "captured",
          errorDescription: "Late authorization confirmation captured via reconcile polling.",
        }).returning();

        const [newCase] = await db.insert(paymentCases).values({
          orderId: order.id,
          status: "resolved",
          failureCategory: "transient",
          confidence: "0.95",
          plainExplanation: "Initial timeout was resolved by a late capture confirmation. No alternate link needed.",
          recommendedAction: "none",
        }).returning();

        return NextResponse.json({ success: true, case_id: newCase.id, scenario: scenarioName, order_id: order.id });
      }

      // -------------------------------------------------------------
      // 4. Customer Abandoned Checkout
      // -------------------------------------------------------------
      case "checkout_abandoned": {
        const [order] = await db.insert(orders).values({
          merchantId: merchant.id,
          externalOrderId: `ord_abnd_${timestamp}`,
          amount: 3500,
          currency: "USD",
          status: "failed",
        }).returning();

        await db.insert(paymentAttempts).values({
          orderId: order.id,
          providerPaymentId: `pay_abnd_${timestamp}`,
          status: "initiated",
          errorDescription: "Customer closed payment modal without entering card details.",
        });

        const [newCase] = await db.insert(paymentCases).values({
          orderId: order.id,
          status: "open",
          failureCategory: "customer_action",
          confidence: "0.85",
          plainExplanation: "Customer initiated checkout but abandoned before submitting authorization.",
          recommendedAction: "send_alternate_payment_link",
        }).returning();

        return NextResponse.json({ success: true, case_id: newCase.id, scenario: scenarioName, order_id: order.id });
      }

      // -------------------------------------------------------------
      // 5. Duplicate Payment Attempt for Single Order
      // -------------------------------------------------------------
      case "duplicate_payment_attempt": {
        const [order] = await db.insert(orders).values({
          merchantId: merchant.id,
          externalOrderId: `ord_dup_${timestamp}`,
          amount: 4900,
          currency: "USD",
          status: "pending",
        }).returning();

        await db.insert(paymentAttempts).values({
          orderId: order.id,
          providerPaymentId: `pay_dup1_${timestamp}`,
          status: "initiated",
        });

        await db.insert(paymentAttempts).values({
          orderId: order.id,
          providerPaymentId: `pay_dup2_${timestamp}`,
          status: "initiated",
          errorDescription: "Duplicate attempt detected in flight.",
        });

        const [newCase] = await db.insert(paymentCases).values({
          orderId: order.id,
          status: "action_required",
          failureCategory: "customer_action",
          confidence: "0.90",
          plainExplanation: "Two payment attempts detected in rapid succession for the same order. Do not charge twice.",
          recommendedAction: "escalate_support",
        }).returning();

        return NextResponse.json({ success: true, case_id: newCase.id, scenario: scenarioName, order_id: order.id });
      }

      // -------------------------------------------------------------
      // 6. Payment Debited with Refund Pending
      // -------------------------------------------------------------
      case "payment_debited_refund_pending": {
        const [order] = await db.insert(orders).values({
          merchantId: merchant.id,
          externalOrderId: `ord_debited_${timestamp}`,
          amount: 9900,
          currency: "USD",
          status: "failed",
        }).returning();

        await db.insert(paymentAttempts).values({
          orderId: order.id,
          providerPaymentId: `pay_deb_${timestamp}`,
          status: "refunded",
          errorCode: "ACQUIRER_AUTO_REVERSAL",
          errorDescription: "Customer account was debited, but gateway auto-refunded due to capture timeout.",
        });

        const [newCase] = await db.insert(paymentCases).values({
          orderId: order.id,
          status: "open",
          failureCategory: "finance_exception",
          confidence: "0.93",
          plainExplanation: "Customer card was debited; acquirer auto-refund is currently processing back to card.",
          recommendedAction: "send_alternate_payment_link",
        }).returning();

        return NextResponse.json({ success: true, case_id: newCase.id, scenario: scenarioName, order_id: order.id });
      }

      // -------------------------------------------------------------
      // 7. Missing Webhook Recovered via API Polling
      // -------------------------------------------------------------
      case "missing_webhook_api_fetch": {
        const [order] = await db.insert(orders).values({
          merchantId: merchant.id,
          externalOrderId: `ord_misfetch_${timestamp}`,
          amount: 6000,
          currency: "GBP",
          status: "completed",
        }).returning();

        await db.insert(paymentAttempts).values({
          orderId: order.id,
          providerPaymentId: `pay_mis_${timestamp}`,
          status: "captured",
          errorDescription: "Missing webhook recovered via scheduled server reconcile fetch.",
        });

        const [newCase] = await db.insert(paymentCases).values({
          orderId: order.id,
          status: "resolved",
          failureCategory: "transient",
          confidence: "0.98",
          plainExplanation: "Webhook was dropped by network rail, but server verified capture via direct API fetch.",
          recommendedAction: "none",
        }).returning();

        return NextResponse.json({ success: true, case_id: newCase.id, scenario: scenarioName, order_id: order.id });
      }

      // -------------------------------------------------------------
      // 8. Out of Order Webhook Arrival
      // -------------------------------------------------------------
      case "out_of_order_webhooks": {
        const [order] = await db.insert(orders).values({
          merchantId: merchant.id,
          externalOrderId: `ord_ooo_${timestamp}`,
          amount: 4200,
          currency: "USD",
          status: "completed",
        }).returning();

        // Simulate capture stored before initiated
        await db.insert(webhookEvents).values({
          providerEventId: `evt_cap_${timestamp}`,
          eventType: "payment.captured",
          rawBody: JSON.stringify({ event: "payment.captured" }),
          signatureValid: true,
          processed: true,
        });

        await db.insert(webhookEvents).values({
          providerEventId: `evt_init_${timestamp}`,
          eventType: "payment.created",
          rawBody: JSON.stringify({ event: "payment.created" }),
          signatureValid: true,
          processed: true,
        });

        await db.insert(paymentAttempts).values({
          orderId: order.id,
          providerPaymentId: `pay_ooo_${timestamp}`,
          status: "captured",
          errorDescription: "State machine preserved captured terminal state despite delayed created event.",
        });

        const [newCase] = await db.insert(paymentCases).values({
          orderId: order.id,
          status: "resolved",
          failureCategory: "transient",
          confidence: "0.99",
          plainExplanation: "Webhooks arrived out-of-order; canonical state machine preserved terminal captured state.",
          recommendedAction: "none",
        }).returning();

        return NextResponse.json({ success: true, case_id: newCase.id, scenario: scenarioName, order_id: order.id });
      }

      // -------------------------------------------------------------
      // 9. Payment Captured Without Settlement Present
      // -------------------------------------------------------------
      case "captured_without_settlement": {
        const [order] = await db.insert(orders).values({
          merchantId: merchant.id,
          externalOrderId: `ord_nosettle_${timestamp}`,
          amount: 8500,
          currency: "USD",
          status: "completed",
        }).returning();

        const payId = `pay_nosettle_${timestamp}`;
        await db.insert(paymentAttempts).values({
          orderId: order.id,
          providerPaymentId: payId,
          status: "captured",
        });

        // Insert Recon Item exception
        await db.insert(reconItems).values({
          sourceType: "payment",
          sourceId: payId,
          expected: 8500,
          actual: 0,
          difference: 8500,
          status: "pending",
          explanation: "Payment is captured, awaiting T+2 settlement credit from acquiring bank.",
        });

        return NextResponse.json({ success: true, scenario: scenarioName, order_id: order.id });
      }

      // -------------------------------------------------------------
      // 10. Settlement Shortfall Due to Fee and Tax
      // -------------------------------------------------------------
      case "settlement_shortfall_fee_tax": {
        const payId = `pay_shortfall_${timestamp}`;
        const settId = `set_shortfall_${timestamp}`;

        // Gross: 10000 INR ($120), Fee: 300 INR, Tax: 54 INR, Net Expected: 9646 INR, Actual Credited: 9500 INR (146 INR gap)
        await db.insert(settlements).values({
          providerSettlementId: settId,
          paymentId: payId,
          gross: 10000,
          fee: 300,
          tax: 54,
          net: 9500,
          currency: "INR",
          settledAt: new Date(),
        });

        await db.insert(reconItems).values({
          sourceType: "settlement",
          sourceId: settId,
          expected: 9646,
          actual: 9500,
          difference: -146,
          status: "discrepancy",
          explanation: "Shortfall of 1.46 INR. Cross-border currency conversion fee or withheld reserve detected.",
        });

        return NextResponse.json({ success: true, scenario: scenarioName, settlement_id: settId, discrepancy_cents: 146 });
      }

      // -------------------------------------------------------------
      // 11. Risk Block That Must NOT Be Bypassed
      // -------------------------------------------------------------
      case "risk_block_do_not_bypass": {
        const [order] = await db.insert(orders).values({
          merchantId: merchant.id,
          externalOrderId: `ord_risk_${timestamp}`,
          amount: 25000,
          currency: "USD",
          status: "failed",
        }).returning();

        await db.insert(paymentAttempts).values({
          orderId: order.id,
          providerPaymentId: `pay_risk_${timestamp}`,
          status: "failed",
          errorCode: "TRANSACTION_RISK_BLOCKED",
          errorDescription: "High-risk fraud score flagged. Velocity rule triggered.",
        });

        const [newCase] = await db.insert(paymentCases).values({
          orderId: order.id,
          status: "action_required",
          failureCategory: "risk_block",
          confidence: "0.96",
          plainExplanation: "Fraud risk rule triggered. Policy STRICTLY prohibits autonomous retry or bypassing.",
          recommendedAction: "escalate_support",
        }).returning();

        return NextResponse.json({ success: true, case_id: newCase.id, scenario: scenarioName, order_id: order.id });
      }

      // -------------------------------------------------------------
      // 12. Insufficient Evidence and Unknown Status
      // -------------------------------------------------------------
      case "insufficient_evidence_unknown": {
        const [order] = await db.insert(orders).values({
          merchantId: merchant.id,
          externalOrderId: `ord_unk_${timestamp}`,
          amount: 5000,
          currency: "USD",
          status: "pending",
        }).returning();

        await db.insert(paymentAttempts).values({
          orderId: order.id,
          providerPaymentId: `pay_unk_${timestamp}`,
          status: "unknown",
          errorDescription: "Empty or conflicting status from acquirer rail.",
        });

        const [newCase] = await db.insert(paymentCases).values({
          orderId: order.id,
          status: "open",
          failureCategory: "unknown",
          confidence: "0.45",
          plainExplanation: "Evidence is incomplete or conflicting. Zero fabricated certainty.",
          recommendedAction: "escalate_support",
        }).returning();

        return NextResponse.json({ success: true, case_id: newCase.id, scenario: scenarioName, order_id: order.id });
      }

      default:
        return NextResponse.json(
          {
            error: `Unknown scenario '${scenarioName}'. Supported scenarios: [international_3ds_fail, issuer_decline, bank_timeout_late_success, checkout_abandoned, duplicate_payment_attempt, payment_debited_refund_pending, missing_webhook_api_fetch, out_of_order_webhooks, captured_without_settlement, settlement_shortfall_fee_tax, risk_block_do_not_bypass, insufficient_evidence_unknown]`,
          },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error("Error running scenario seed:", error);
    return NextResponse.json(
      { error: "Internal server error running scenario" },
      { status: 500 }
    );
  }
}
