import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { paymentCases, orders } from "@/db/schema";
import { eq, and, ne } from "drizzle-orm";
import { createRecoveryPaymentLink } from "@/lib/connectors/razorpay";
import { logAuditEvent } from "@/lib/domain/audit";
import { getRequestId, requireAdmin } from "@/lib/http";

export const dynamic = "force-dynamic";

const MAX_BATCH_SIZE = 25;

/**
 * Batch recovery executor with safety rails:
 * - Only cases explicitly recommended for alternate links are eligible.
 *   `risk_block` / `merchant_config` / `unknown` cases NEVER auto-execute.
 * - Batch size is clamped to MAX_BATCH_SIZE.
 * - Idempotency keys are stable per calendar day + case, so an accidental
 *   double-execute returns the existing action instead of double-charging.
 */
export async function POST(req: NextRequest) {
  try {
    const adminBlock = requireAdmin(req);
    if (adminBlock) return adminBlock;
    const requestId = getRequestId(req, "batch");

    const body = await req.json().catch(() => ({}));
    const mode = body?.mode || "preview"; // 'preview' or 'execute'
    const operator = String(body?.operator || "lead_operator").slice(0, 255);
    const requestedBatch = Number(body?.max_batch_size) || 10;
    const maxBatchSize = Math.min(Math.max(requestedBatch, 1), MAX_BATCH_SIZE);

    // 1. Eligible = open + explicitly link-recoverable + never a risk block
    const eligible = await db
      .select({
        caseId: paymentCases.id,
        status: paymentCases.status,
        failureCategory: paymentCases.failureCategory,
        recommendedAction: paymentCases.recommendedAction,
        orderId: orders.id,
        amount: orders.amount,
        currency: orders.currency,
        externalOrderId: orders.externalOrderId,
      })
      .from(paymentCases)
      .innerJoin(orders, eq(paymentCases.orderId, orders.id))
      .where(
        and(
          eq(paymentCases.status, "open"),
          eq(paymentCases.recommendedAction, "send_alternate_payment_link"),
          ne(paymentCases.failureCategory, "risk_block")
        )
      )
      .limit(maxBatchSize);

    const totalEligibleAmount = eligible.reduce((acc, c) => acc + c.amount, 0);

    if (mode === "preview") {
      return NextResponse.json({
        success: true,
        mode: "preview",
        eligible_count: eligible.length,
        total_amount_at_risk_formatted: `$${(totalEligibleAmount / 100).toFixed(2)}`,
        eligible_cases: eligible,
      });
    }

    if (mode !== "execute") {
      return NextResponse.json(
        { error: `Unsupported mode: '${mode}'. Use 'preview' or 'execute'.` },
        { status: 400 }
      );
    }

    // 2. Execution Mode: Process cases with safety stopping rules
    const results: Array<{
      case_id: string;
      order_id: string;
      payment_link: string;
      status: string;
    }> = [];

    let totalRecovered = 0;
    const day = new Date().toISOString().slice(0, 10);

    for (const item of eligible) {
      try {
        const idempKey = `batch_${day}_${item.caseId}`;
        const res = await createRecoveryPaymentLink(
          item.caseId,
          item.amount,
          item.currency,
          idempKey,
          operator
        );

        results.push({
          case_id: item.caseId,
          order_id: item.externalOrderId,
          payment_link: res.success ? res.payment_link_url : "",
          status: res.success ? "executed" : "failed",
        });

        if (res.success) totalRecovered += item.amount;
      } catch (err: any) {
        console.error(`Error in batch recovery for case ${item.caseId}:`, err);
        results.push({
          case_id: item.caseId,
          order_id: item.externalOrderId,
          payment_link: "",
          status: "failed",
        });
      }
    }

    await logAuditEvent({
      actor: operator,
      action: "batch_recovery_executed",
      entity: "recovery_run",
      after: {
        processed_count: results.length,
        total_recovered_amount: totalRecovered,
      },
      requestId,
    });

    return NextResponse.json({
      success: true,
      mode: "execute",
      processed_count: results.length,
      total_recovered_formatted: `$${(totalRecovered / 100).toFixed(2)}`,
      results,
    });
  } catch (error) {
    console.error("Error executing recovery run:", error);
    return NextResponse.json(
      { error: "Internal server error running recovery batch" },
      { status: 500 }
    );
  }
}
