import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import {
  recoveryActions,
  paymentCases,
  paymentLinks,
  orders,
  paymentAttempts,
} from "@/db/schema";
import { eq } from "drizzle-orm";
import { isDemoMode } from "@/lib/gateway";
import { logAuditEvent } from "@/lib/domain/audit";
import { getRequestId, isUuid } from "@/lib/http";
import { notifyMerchant } from "@/lib/notify";

export const dynamic = "force-dynamic";

async function loadCheckout(actionId: string) {
  const [action] = await db
    .select()
    .from(recoveryActions)
    .where(eq(recoveryActions.id, actionId))
    .limit(1);
  if (!action) return null;
  const [link] = await db
    .select()
    .from(paymentLinks)
    .where(eq(paymentLinks.caseId, action.caseId))
    .limit(1);
  const [c] = await db
    .select()
    .from(paymentCases)
    .where(eq(paymentCases.id, action.caseId))
    .limit(1);
  const [order] = c
    ? await db.select().from(orders).where(eq(orders.id, c.orderId)).limit(1)
    : [];
  return { action, link: link ?? null, case: c ?? null, order: order ?? null };
}

/** Public demo checkout summary. Only exists in DEMO_MODE. */
export async function GET(
  _req: NextRequest,
  { params }: { params: { actionId: string } }
) {
  if (!isDemoMode()) {
    return NextResponse.json({ error: "Demo checkout is disabled" }, { status: 403 });
  }
  if (!isUuid(params?.actionId)) {
    return NextResponse.json({ error: "Unknown checkout" }, { status: 404 });
  }
  const data = await loadCheckout(params.actionId);
  if (!data || !data.link || !data.order) {
    return NextResponse.json({ error: "Checkout not found" }, { status: 404 });
  }
  const expired = data.link.expiry ? new Date(data.link.expiry) < new Date() : false;
  return NextResponse.json({
    success: true,
    demo: true,
    checkout: {
      amount: data.link.amount,
      currency: data.link.currency,
      order_ref: data.order.externalOrderId,
      status: expired ? "expired" : data.link.status,
      expiry: data.link.expiry,
      action_status: data.action.status,
    },
  });
}

/**
 * Simulated customer payment. Creates a captured attempt, marks the demo
 * link paid, resolves the case — the full recovery loop with zero real money.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { actionId: string } }
) {
  if (!isDemoMode()) {
    return NextResponse.json({ error: "Demo checkout is disabled" }, { status: 403 });
  }
  if (!isUuid(params?.actionId)) {
    return NextResponse.json({ error: "Unknown checkout" }, { status: 404 });
  }
  const requestId = getRequestId(req, "demopay");

  const data = await loadCheckout(params.actionId);
  if (!data || !data.link || !data.order || !data.case) {
    return NextResponse.json({ error: "Checkout not found" }, { status: 404 });
  }
  if (data.link.status === "paid") {
    return NextResponse.json({ success: true, already_paid: true });
  }
  if (data.link.expiry && new Date(data.link.expiry) < new Date()) {
    return NextResponse.json({ error: "This demo link has expired" }, { status: 410 });
  }
  if (data.link.status !== "created") {
    return NextResponse.json({ error: "This demo link is no longer payable" }, { status: 409 });
  }

  const demoPayId = `demo_pay_${data.action.id.replace(/-/g, "").slice(0, 12)}`;
  const [existing] = await db
    .select()
    .from(paymentAttempts)
    .where(eq(paymentAttempts.providerPaymentId, demoPayId))
    .limit(1);

  if (!existing) {
    await db.insert(paymentAttempts).values({
      orderId: data.order.id,
      providerPaymentId: demoPayId,
      method: "card",
      country: data.order.currency === "INR" ? "IN" : "US",
      status: "captured",
      errorDescription: "Demo sandbox payment completed by simulated customer.",
    });
  }

  await db
    .update(paymentLinks)
    .set({ status: "paid" })
    .where(eq(paymentLinks.id, data.link.id));
  await db
    .update(paymentCases)
    .set({
      status: "resolved",
      recommendedAction: `Paid via demo checkout (${data.link.url})`,
    })
    .where(eq(paymentCases.id, data.case.id));

  await logAuditEvent({
    actor: "demo_customer",
    action: "demo_payment_captured",
    entity: "payment_case",
    entityId: data.case.id,
    after: { demo_pay_id: demoPayId, link_id: data.link.providerLinkId },
    requestId,
  });

  void notifyMerchant({
    merchantId: data.order.merchantId,
    caseId: data.case.id,
    type: "recovery_link_paid",
    title: `Demo checkout paid (case ${data.case.id.slice(0, 8)})`,
    body: `Simulated customer completed the demo checkout. No real money moved.`,
  });

  return NextResponse.json({ success: true, demo: true, payment_id: demoPayId });
}
