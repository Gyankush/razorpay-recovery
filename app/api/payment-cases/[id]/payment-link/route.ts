import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { paymentCases, orders } from "@/db/schema";
import { eq } from "drizzle-orm";
import { createRecoveryPaymentLink } from "@/lib/connectors/razorpay";
import { logAuditEvent } from "@/lib/domain/audit";
import { getRequestId, isUuid } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const caseId = params?.id;
    if (!caseId || !isUuid(caseId)) {
      return NextResponse.json({ error: "Valid case ID required" }, { status: 400 });
    }
    const requestId = getRequestId(request, "plink");

    let body: Record<string, unknown> = {};
    try {
      body = await request.json();
    } catch {
      // Body may be empty; idempotency key check below will reject it
    }

    // Guardrail: Require human approval + client-supplied idempotency key
    const approvedBy = String(
      (body as Record<string, unknown>)?.approved_by || "merchant_operator"
    ).slice(0, 255);
    const idempotencyKey = (body as Record<string, unknown>)?.idempotency_key;

    if (!idempotencyKey || String(idempotencyKey).length < 8) {
      return NextResponse.json(
        { error: "idempotency_key is required (min 8 chars, UUID recommended)" },
        { status: 400 }
      );
    }

    // 1. Fetch case & order
    const [paymentCase] = await db
      .select()
      .from(paymentCases)
      .where(eq(paymentCases.id, caseId))
      .limit(1);

    if (!paymentCase) {
      return NextResponse.json({ error: "Case not found" }, { status: 404 });
    }

    if (paymentCase.status === "resolved") {
      return NextResponse.json(
        { error: "Case is already resolved", case_id: paymentCase.id },
        { status: 409 }
      );
    }

    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, paymentCase.orderId))
      .limit(1);

    if (!order) {
      return NextResponse.json(
        { error: "Associated order not found" },
        { status: 404 }
      );
    }

    // 2. Execute bounded recovery action
    const recoveryResult = await createRecoveryPaymentLink(
      paymentCase.id,
      order.amount,
      order.currency,
      String(idempotencyKey),
      approvedBy
    );

    await logAuditEvent({
      actor: approvedBy,
      action: recoveryResult.success
        ? "action_create_payment_link"
        : "action_create_payment_link_failed",
      entity: "recovery_action",
      entityId: recoveryResult.action.id,
      after: recoveryResult.success
        ? { url: recoveryResult.payment_link_url }
        : { error: recoveryResult.error },
      requestId,
    });

    if (!recoveryResult.success) {
      return NextResponse.json(
        {
          success: false,
          case_id: paymentCase.id,
          action: recoveryResult.action,
          error: recoveryResult.error ?? "Failed to create recovery payment link",
        },
        { status: 502 }
      );
    }

    return NextResponse.json({
      success: true,
      case_id: paymentCase.id,
      payment_link: recoveryResult.payment_link_url,
      payment_link_id: recoveryResult.payment_link_id,
      action: recoveryResult.action,
      already_existed: recoveryResult.already_existed,
      status: "resolved",
      message:
        "Alternate recovery Payment Link generated successfully. Case marked as resolved.",
    });
  } catch (error) {
    console.error("Error executing recovery payment link:", error);
    return NextResponse.json(
      { error: "Failed to create recovery payment link" },
      { status: 500 }
    );
  }
}
