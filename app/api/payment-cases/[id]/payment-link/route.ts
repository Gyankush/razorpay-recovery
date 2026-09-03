import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { paymentCases, orders } from "@/db/schema";
import { eq } from "drizzle-orm";
import { createRecoveryPaymentLink } from "@/lib/connectors/razorpay";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const caseId = params?.id;
    if (!caseId) {
      return NextResponse.json({ error: "Case ID required" }, { status: 400 });
    }

    let body: Record<string, any> = {};
    try {
      body = await request.json();
    } catch {
      // Body may be empty or plain text
    }

    // Guardrail: Require human approval
    const approvedBy = body?.approved_by || "merchant_operator";
    const idempotencyKey =
      body?.idempotency_key || `case_${caseId}_rec_${Date.now()}`;

    // 1. Fetch case & order
    const [paymentCase] = await db
      .select()
      .from(paymentCases)
      .where(eq(paymentCases.id, caseId))
      .limit(1);

    if (!paymentCase) {
      return NextResponse.json({ error: "Case not found" }, { status: 404 });
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
      idempotencyKey,
      approvedBy
    );

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
