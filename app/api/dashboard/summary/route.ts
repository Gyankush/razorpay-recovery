import { NextResponse } from "next/server";
import { db } from "@/db";
import { paymentCases, orders } from "@/db/schema";
import { eq, sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // Aggregate in SQL (never pull whole tables into Node), grouped by
    // currency — summing USD cents with INR paise into one "$" number was
    // the old bug. Totals below are cross-currency approximations; the
    // `by_currency` breakdown is the trustworthy view.
    const rows = await db
      .select({
        caseStatus: paymentCases.status,
        recommendedAction: paymentCases.recommendedAction,
        currency: orders.currency,
        totalCents: sql<number>`sum(${orders.amount})`,
        count: sql<number>`count(*)`,
      })
      .from(paymentCases)
      .innerJoin(orders, eq(paymentCases.orderId, orders.id))
      .groupBy(paymentCases.status, paymentCases.recommendedAction, orders.currency);

    let moneyAtRiskCents = 0;
    let recoveredAmountCents = 0;
    let recoverableCount = 0;
    let unresolvedCount = 0;
    let resolvedCount = 0;
    let totalCases = 0;

    const byCurrency = new Map<
      string,
      { currency: string; at_risk_cents: number; recovered_cents: number; open: number; resolved: number }
    >();

    const bucket = (currency: string) => {
      let b = byCurrency.get(currency);
      if (!b) {
        b = { currency, at_risk_cents: 0, recovered_cents: 0, open: 0, resolved: 0 };
        byCurrency.set(currency, b);
      }
      return b;
    };

    for (const row of rows) {
      const cents = Number(row.totalCents);
      const n = Number(row.count);
      totalCases += n;
      const b = bucket(row.currency);
      if (row.caseStatus === "open" || row.caseStatus === "action_required") {
        unresolvedCount += n;
        moneyAtRiskCents += cents;
        b.at_risk_cents += cents;
        b.open += n;
        if (row.recommendedAction === "send_alternate_payment_link") {
          recoverableCount += n;
        }
      } else if (row.caseStatus === "resolved") {
        resolvedCount += n;
        recoveredAmountCents += cents;
        b.recovered_cents += cents;
        b.resolved += n;
      }
    }

    const breakdown = Array.from(byCurrency.values());
    return NextResponse.json({
      success: true,
      summary: {
        money_at_risk: moneyAtRiskCents / 100,
        money_at_risk_cents: moneyAtRiskCents,
        recoverable_cases_count: recoverableCount,
        unresolved_cases_count: unresolvedCount,
        recovered_amount: recoveredAmountCents / 100,
        recovered_amount_cents: recoveredAmountCents,
        resolved_cases_count: resolvedCount,
        total_cases_count: totalCases,
        multi_currency: breakdown.length > 1,
        by_currency: breakdown,
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
