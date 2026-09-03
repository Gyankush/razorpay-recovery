import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import {
  paymentCases,
  orders,
  merchants,
  paymentAttempts,
  recoveryActions,
} from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { diagnoseFromEntities } from "@/lib/ai/diagnose";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const caseId = params?.id;
    if (!caseId) {
      return NextResponse.json({ error: "Case ID required" }, { status: 400 });
    }

    // 1. Fetch Case
    const [paymentCase] = await db
      .select()
      .from(paymentCases)
      .where(eq(paymentCases.id, caseId))
      .limit(1);

    if (!paymentCase) {
      return NextResponse.json({ error: "Payment case not found" }, { status: 404 });
    }

    // 2. Fetch Parent Order
    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, paymentCase.orderId))
      .limit(1);

    // 3. Fetch Merchant
    let merchant = null;
    if (order?.merchantId) {
      const [m] = await db
        .select()
        .from(merchants)
        .where(eq(merchants.id, order.merchantId))
        .limit(1);
      merchant = m || null;
    }

    // 4. Fetch Payment Attempts
    const attempts = await db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.orderId, paymentCase.orderId))
      .orderBy(desc(paymentAttempts.createdAt));

    const latestAttempt = attempts[0] || null;

    // 5. Fetch Recovery Actions
    const actions = await db
      .select()
      .from(recoveryActions)
      .where(eq(recoveryActions.caseId, caseId))
      .orderBy(desc(recoveryActions.createdAt));

    // 6. Compute AI Diagnosis
    const diagnosis = diagnoseFromEntities(paymentCase, latestAttempt, order);

    // 7. Assemble chronological timeline
    const timeline: Array<{
      step: number;
      name: string;
      status: string;
      timestamp: string;
      details: string;
      meta?: Record<string, any>;
    }> = [];

    // Step 1: Order Initiated
    if (order) {
      timeline.push({
        step: 1,
        name: "Order Created",
        status: "completed",
        timestamp: order.createdAt.toISOString(),
        details: `External Order #${order.externalOrderId} initiated for ${(
          order.amount / 100
        ).toFixed(2)} ${order.currency}.`,
        meta: { amount: order.amount, currency: order.currency },
      });
    }

    // Step 2: Payment Attempts
    for (let i = attempts.length - 1; i >= 0; i--) {
      const att = attempts[i];
      timeline.push({
        step: 2,
        name: `Payment Attempt ${att.status.toUpperCase()}`,
        status: att.status === "failed" ? "failed" : "completed",
        timestamp: att.createdAt.toISOString(),
        details: att.errorDescription
          ? `${att.errorDescription} (${att.errorCode || "No error code"})`
          : `Gateway attempt recorded with status: ${att.status}`,
        meta: {
          providerPaymentId: att.providerPaymentId,
          errorCode: att.errorCode,
        },
      });
    }

    // Step 3: Payment Case Opened
    timeline.push({
      step: 3,
      name: "Payment Case Opened",
      status: "active",
      timestamp: paymentCase.createdAt.toISOString(),
      details: `AI diagnosed failure category: ${diagnosis.category}. Recommended action: ${diagnosis.recommended_action}.`,
      meta: {
        category: diagnosis.category,
        confidence: diagnosis.confidence,
      },
    });

    // Step 4: Recovery Actions
    for (const act of actions) {
      timeline.push({
        step: 4,
        name: `Recovery: ${act.actionType}`,
        status: act.status,
        timestamp: (act.executedAt || act.createdAt).toISOString(),
        details: `Approved by ${act.approvedBy || "operator"}. Status: ${act.status}.`,
        meta: {
          idempotencyKey: act.idempotencyKey,
        },
      });
    }

    return NextResponse.json({
      success: true,
      case: paymentCase,
      order: order
        ? {
            ...order,
            amount_formatted: (order.amount / 100).toFixed(2),
          }
        : null,
      merchant,
      attempts,
      latest_attempt: latestAttempt,
      recovery_actions: actions,
      diagnosis,
      timeline,
    });
  } catch (error) {
    console.error("Error fetching case details:", error);
    return NextResponse.json(
      { error: "Internal server error fetching case detail" },
      { status: 500 }
    );
  }
}
