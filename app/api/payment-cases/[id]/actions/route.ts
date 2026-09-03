import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { paymentCases, orders, recoveryActions } from "@/db/schema";
import { eq } from "drizzle-orm";
import { createRecoveryPaymentLink } from "@/lib/connectors/razorpay";
import { logAuditEvent } from "@/lib/domain/audit";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const caseId = params?.id;
    if (!caseId) {
      return NextResponse.json({ error: "Case ID required" }, { status: 400 });
    }

    const body = await req.json().catch(() => ({}));
    const actionType = body?.action_type || "create_payment_link";
    const approvedBy = body?.approved_by || "operator";
    const idempotencyKey =
      body?.idempotency_key || `act_${caseId}_${Date.now()}`;

    const [c] = await db
      .select()
      .from(paymentCases)
      .where(eq(paymentCases.id, caseId))
      .limit(1);

    if (!c) {
      return NextResponse.json({ error: "Case not found" }, { status: 404 });
    }

    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, c.orderId))
      .limit(1);

    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    if (actionType === "create_payment_link") {
      const result = await createRecoveryPaymentLink(
        c.id,
        order.amount,
        order.currency,
        idempotencyKey,
        approvedBy
      );

      await logAuditEvent({
        actor: approvedBy,
        action: "action_create_payment_link",
        entity: "recovery_action",
        entityId: result.action.id,
        after: result,
      });

      return NextResponse.json({
        success: true,
        case_id: c.id,
        action: result.action,
        payment_link: result.payment_link_url,
      });
    }

    if (actionType === "escalate_support") {
      const [action] = await db
        .insert(recoveryActions)
        .values({
          caseId: c.id,
          actionType: "escalate_support",
          status: "executed",
          idempotencyKey,
          approvedBy,
          executedAt: new Date(),
          resultJson: JSON.stringify({ note: "Escalated to front-line support desk" }),
        })
        .returning();

      await db
        .update(paymentCases)
        .set({ status: "action_required" })
        .where(eq(paymentCases.id, c.id));

      await logAuditEvent({
        actor: approvedBy,
        action: "action_escalated_support",
        entity: "payment_case",
        entityId: c.id,
      });

      return NextResponse.json({ success: true, case_id: c.id, action });
    }

    if (actionType === "cooldown_retry") {
      const [action] = await db
        .insert(recoveryActions)
        .values({
          caseId: c.id,
          actionType: "cooldown_retry",
          status: "executed",
          idempotencyKey,
          approvedBy,
          executedAt: new Date(),
          resultJson: JSON.stringify({ cooldown_minutes: 15 }),
        })
        .returning();

      await logAuditEvent({
        actor: approvedBy,
        action: "action_cooldown_scheduled",
        entity: "payment_case",
        entityId: c.id,
      });

      return NextResponse.json({ success: true, case_id: c.id, action });
    }

    return NextResponse.json(
      { error: `Unsupported action type: '${actionType}'` },
      { status: 400 }
    );
  } catch (error) {
    console.error("Error executing case action:", error);
    return NextResponse.json(
      { error: "Internal server error executing action" },
      { status: 500 }
    );
  }
}
