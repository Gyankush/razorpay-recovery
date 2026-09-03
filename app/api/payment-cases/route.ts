import { NextResponse } from "next/server";
import { db } from "@/db";
import { paymentCases, orders, paymentAttempts } from "@/db/schema";
import { eq, desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rawCases = await db
      .select({
        id: paymentCases.id,
        orderId: paymentCases.orderId,
        status: paymentCases.status,
        failureCategory: paymentCases.failureCategory,
        confidence: paymentCases.confidence,
        plainExplanation: paymentCases.plainExplanation,
        recommendedAction: paymentCases.recommendedAction,
        createdAt: paymentCases.createdAt,
        // Order details
        externalOrderId: orders.externalOrderId,
        amount: orders.amount,
        currency: orders.currency,
        orderStatus: orders.status,
      })
      .from(paymentCases)
      .innerJoin(orders, eq(paymentCases.orderId, orders.id))
      .orderBy(desc(paymentCases.createdAt));

    // Fetch attempts for all orders
    const attempts = await db
      .select()
      .from(paymentAttempts)
      .orderBy(desc(paymentAttempts.createdAt));

    // Group attempts by orderId
    const attemptsByOrder = new Map<string, typeof attempts>();
    for (const att of attempts) {
      const list = attemptsByOrder.get(att.orderId) || [];
      list.push(att);
      attemptsByOrder.set(att.orderId, list);
    }

    const cases = rawCases.map((c) => {
      const orderAttempts = attemptsByOrder.get(c.orderId) || [];
      const latestAttempt = orderAttempts[0] || null;

      return {
        ...c,
        amount_formatted: (c.amount / 100).toFixed(2),
        latest_error_code: latestAttempt?.errorCode || null,
        latest_error_description: latestAttempt?.errorDescription || null,
        provider_payment_id: latestAttempt?.providerPaymentId || null,
        attempts_count: orderAttempts.length,
      };
    });

    return NextResponse.json({
      success: true,
      cases,
    });
  } catch (error) {
    console.error("Error fetching payment cases:", error);
    return NextResponse.json(
      { error: "Failed to fetch payment cases" },
      { status: 500 }
    );
  }
}
