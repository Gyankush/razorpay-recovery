import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { paymentCases, orders, recoveryActions } from "@/db/schema";
import { eq } from "drizzle-orm";
import { createRecoveryPaymentLink } from "@/lib/connectors/razorpay";
import { logAuditEvent } from "@/lib/domain/audit";
import { getRequestId, isUuid } from "@/lib/http";

export const dynamic = "force-dynamic";

const SUPPORTED_ACTIONS = new Set([
  "create_payment_link",
  "escalate_support",
  "cooldown_retry",
]);

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const caseId = params?.id;
    if (!caseId || !isUuid(caseId)) {
      return NextResponse.json({ error: "Valid case ID required" }, { status: 400 });
    }
    const requestId = getRequestId(req, "act");

    const body = await req.json().catch(() => ({}));
    const actionType = body?.action_type || "create_payment_link";
    const approvedBy = String(body?.approved_by || "operator").slice(0, 255);
    const idempotencyKey = body?.idempotency_key;

    if (!SUPPORTED_ACTIONS.has(actionType)) {
      return NextResponse.json(
        { error: `Unsupported action type: '${actionType}'` },
        { status: 400 }
      );
    }

    // Idempotency keys are mandatory: server-generated Date.now() keys would
    // create a new action on every client retry, defeating exactly-once.
    if (!idempotencyKey || String(idempotencyKey).length < 8) {
      return NextResponse.json(
        { error: "idempotency_key is required (min 8 chars, UUID recommended)" },
        { status: 400 }
      );
    }

    const [c] = await db
      .select()
      .from(paymentCases)
      .where(eq(paymentCases.id, caseId))
      .limit(1);

    if (!c) {
      return NextResponse.json({ error: "Case not found" }, { status: 404 });
    }

    if (c.status === "resolved" && actionType === "create_payment_link") {
      return NextResponse.json(
        { error: "Case is already resolved", case_id: c.id },
        { status: 409 }
      );
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
        String(idempotencyKey),
        approvedBy
      );

      await logAuditEvent({
        actor: approvedBy,
        action: result.success
          ? "action_create_payment_link"
          : "action_create_payment_link_failed",
        entity: "recovery_action",
        entityId: result.action.id,
        after: result.success ? result : { error: result.error },
        requestId,
      });

      if (!result.success) {
        return NextResponse.json(
          {
            success: false,
            case_id: c.id,
            action: result.action,
            error: result.error ?? "Razorpay link creation failed; case left open",
          },
          { status: 502 }
        );
      }

      return NextResponse.json({
        success: true,
        case_id: c.id,
        action: result.action,
        payment_link: result.payment_link_url,
        already_existed: result.already_existed ?? false,
      });
    }

    if (actionType === "escalate_support") {
      const rows = await db
        .insert(recoveryActions)
        .values({
          caseId: c.id,
          actionType: "escalate_support",
          status: "executed",
          idempotencyKey: String(idempotencyKey),
          approvedBy,
          executedAt: new Date(),
          resultJson: JSON.stringify({ note: "Escalated to front-line support desk" }),
        })
        .onConflictDoNothing({ target: recoveryActions.idempotencyKey })
        .returning();
      const action =
        rows[0] ??
        (
          await db
            .select()
            .from(recoveryActions)
            .where(eq(recoveryActions.idempotencyKey, String(idempotencyKey)))
            .limit(1)
        )[0];

      if (rows.length > 0) {
        await db
          .update(paymentCases)
          .set({ status: "action_required" })
          .where(eq(paymentCases.id, c.id));
      }

      await logAuditEvent({
        actor: approvedBy,
        action: "action_escalated_support",
        entity: "payment_case",
        entityId: c.id,
        requestId,
      });

      return NextResponse.json({
        success: true,
        case_id: c.id,
        action,
        already_existed: rows.length === 0,
      });
    }

    // cooldown_retry
    const rows = await db
      .insert(recoveryActions)
      .values({
        caseId: c.id,
        actionType: "cooldown_retry",
        status: "executed",
        idempotencyKey: String(idempotencyKey),
        approvedBy,
        executedAt: new Date(),
        resultJson: JSON.stringify({ cooldown_minutes: 15 }),
      })
      .onConflictDoNothing({ target: recoveryActions.idempotencyKey })
      .returning();
    const action =
      rows[0] ??
      (
        await db
          .select()
          .from(recoveryActions)
          .where(eq(recoveryActions.idempotencyKey, String(idempotencyKey)))
          .limit(1)
      )[0];

    await logAuditEvent({
      actor: approvedBy,
      action: "action_cooldown_scheduled",
      entity: "payment_case",
      entityId: c.id,
      requestId,
    });

    return NextResponse.json({
      success: true,
      case_id: c.id,
      action,
      already_existed: rows.length === 0,
    });
  } catch (error) {
    console.error("Error executing case action:", error);
    return NextResponse.json(
      { error: "Internal server error executing action" },
      { status: 500 }
    );
  }
}
