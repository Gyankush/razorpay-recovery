import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { paymentCases, orders, paymentAttempts } from "@/db/schema";
import { eq, desc, inArray } from "drizzle-orm";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const limit = Math.min(
      Math.max(Number(searchParams.get("limit")) || DEFAULT_LIMIT, 1),
      MAX_LIMIT
    );
    const offset = Math.max(Number(searchParams.get("offset")) || 0, 0);
    const status = searchParams.get("status");

    const baseQuery = db
      .select({
        id: paymentCases.id,
        orderId: paymentCases.orderId,
        status: paymentCases.status,
        failureCategory: paymentCases.failureCategory,
        confidence: paymentCases.confidence,
        plainExplanation: paymentCases.plainExplanation,
        recommendedAction: paymentCases.recommendedAction,
        createdAt: paymentCases.createdAt,
        externalOrderId: orders.externalOrderId,
        amount: orders.amount,
        currency: orders.currency,
        orderStatus: orders.status,
      })
      .from(paymentCases)
      .innerJoin(orders, eq(paymentCases.orderId, orders.id))
      .orderBy(desc(paymentCases.createdAt))
      .limit(limit + 1)
      .offset(offset);

    const rawCases =
      status === "open" || status === "resolved" || status === "action_required"
        ? await db
            .select({
              id: paymentCases.id,
              orderId: paymentCases.orderId,
              status: paymentCases.status,
              failureCategory: paymentCases.failureCategory,
              confidence: paymentCases.confidence,
              plainExplanation: paymentCases.plainExplanation,
              recommendedAction: paymentCases.recommendedAction,
              createdAt: paymentCases.createdAt,
              externalOrderId: orders.externalOrderId,
              amount: orders.amount,
              currency: orders.currency,
              orderStatus: orders.status,
            })
            .from(paymentCases)
            .innerJoin(orders, eq(paymentCases.orderId, orders.id))
            .where(eq(paymentCases.status, status as "open" | "resolved" | "action_required"))
            .orderBy(desc(paymentCases.createdAt))
            .limit(limit + 1)
            .offset(offset)
        : await baseQuery;

    const hasMore = rawCases.length > limit;
    const page = rawCases.slice(0, limit);

    // Latest attempt per order on THIS page only (no full-table scan).
    const orderIds = Array.from(new Set(page.map((c) => c.orderId)));
    const attempts =
      orderIds.length > 0
        ? await db
            .select()
            .from(paymentAttempts)
            .where(inArray(paymentAttempts.orderId, orderIds))
            .orderBy(desc(paymentAttempts.createdAt))
        : [];

    const latestByOrder = new Map<string, (typeof attempts)[number]>();
    for (const att of attempts) {
      if (!latestByOrder.has(att.orderId)) latestByOrder.set(att.orderId, att);
    }
    const counts = new Map<string, number>();
    for (const att of attempts) {
      counts.set(att.orderId, (counts.get(att.orderId) ?? 0) + 1);
    }

    const cases = page.map((c) => {
      const latestAttempt = latestByOrder.get(c.orderId) || null;
      return {
        ...c,
        amount_formatted: (c.amount / 100).toFixed(2),
        latest_error_code: latestAttempt?.errorCode || null,
        latest_error_description: latestAttempt?.errorDescription || null,
        provider_payment_id: latestAttempt?.providerPaymentId || null,
        attempts_count: counts.get(c.orderId) ?? 0,
      };
    });

    return NextResponse.json({
      success: true,
      cases,
      pagination: { limit, offset, has_more: hasMore },
    });
  } catch (error) {
    console.error("Error fetching payment cases:", error);
    return NextResponse.json(
      { error: "Failed to fetch payment cases" },
      { status: 500 }
    );
  }
}
