import { NextResponse } from "next/server";
import { db } from "@/db";
import { paymentCases, orders } from "@/db/schema";
import { eq, or, sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // Join paymentCases with orders to aggregate financial metrics
    const casesWithOrders = await db
      .select({
        caseId: paymentCases.id,
        caseStatus: paymentCases.status,
        recommendedAction: paymentCases.recommendedAction,
        amount: orders.amount,
        currency: orders.currency,
      })
      .from(paymentCases)
      .innerJoin(orders, eq(paymentCases.orderId, orders.id));

    let moneyAtRiskCents = 0;
    let recoveredAmountCents = 0;
    let recoverableCount = 0;
    let unresolvedCount = 0;
    let resolvedCount = 0;

    for (const item of casesWithOrders) {
      if (item.caseStatus === "open" || item.caseStatus === "action_required") {
        unresolvedCount++;
        moneyAtRiskCents += item.amount;
        if (
          item.recommendedAction?.includes("payment_link") ||
          item.recommendedAction?.includes("alternate")
        ) {
          recoverableCount++;
        }
      } else if (item.caseStatus === "resolved") {
        resolvedCount++;
        recoveredAmountCents += item.amount;
      }
    }

    return NextResponse.json({
      success: true,
      summary: {
        money_at_risk: moneyAtRiskCents / 100, // in standard currency units (e.g. $49.00)
        money_at_risk_cents: moneyAtRiskCents,
        recoverable_cases_count: recoverableCount,
        unresolved_cases_count: unresolvedCount,
        recovered_amount: recoveredAmountCents / 100,
        recovered_amount_cents: recoveredAmountCents,
        resolved_cases_count: resolvedCount,
        total_cases_count: casesWithOrders.length,
      },
    });
  } catch (error) {
    console.error("Error generating dashboard summary:", error);
    return NextResponse.json(
      { error: "Failed to fetch dashboard summary" },
      { status: 500 }
    );
  }
}
