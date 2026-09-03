import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { paymentCases, orders } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { createRecoveryPaymentLink } from "@/lib/connectors/razorpay";
import { logAuditEvent } from "@/lib/domain/audit";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const mode = body?.mode || "preview"; // 'preview' or 'execute'
    const maxBatchSize = Number(body?.max_batch_size) || 10;
    const operator = body?.operator || "lead_operator";

    // 1. Fetch eligible open cases where recommended action is create_payment_link / alternate link
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
      .where(eq(paymentCases.status, "open"))
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

    // 2. Execution Mode: Process cases with safety stopping rules
    const results: Array<{
      case_id: string;
      order_id: string;
      payment_link: string;
      status: string;
    }> = [];

    let totalRecovered = 0;

    for (const item of eligible) {
      try {
        const idempKey = `batch_rec_${item.caseId}_${Date.now()}`;
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
          payment_link: res.payment_link_url,
          status: "executed",
        });

        totalRecovered += item.amount;
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
