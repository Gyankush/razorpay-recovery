import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { paymentCases, orders, paymentAttempts, diagnoses } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { diagnoseFromEntities } from "@/lib/ai/diagnose";
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

    const attempts = await db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.orderId, c.orderId))
      .orderBy(desc(paymentAttempts.createdAt));

    const latestAttempt = attempts[0] || null;

    // Run deterministic diagnosis
    const diagnosis = diagnoseFromEntities(c, latestAttempt, order);

    // Persist into diagnoses table
    const [savedDiagnosis] = await db
      .insert(diagnoses)
      .values({
        caseId: c.id,
        category: diagnosis.category,
        factsJson: JSON.stringify(diagnosis.facts_used),
        explanation: diagnosis.explanation,
        model: "payrescue-ai-rules-v1",
      })
      .returning();

    // Update case summary fields
    await db
      .update(paymentCases)
      .set({
        failureCategory: diagnosis.category,
        confidence: diagnosis.confidence.toFixed(2),
        plainExplanation: diagnosis.explanation,
        recommendedAction: diagnosis.recommended_action,
      })
      .where(eq(paymentCases.id, c.id));

    await logAuditEvent({
      actor: "ai_engine",
      action: "diagnosis_evaluated",
      entity: "payment_case",
      entityId: c.id,
      after: diagnosis,
    });

    return NextResponse.json({
      success: true,
      case_id: c.id,
      diagnosis_id: savedDiagnosis.id,
      diagnosis,
    });
  } catch (error) {
    console.error("Error executing case diagnosis:", error);
    return NextResponse.json(
      { error: "Failed to evaluate case diagnosis" },
      { status: 500 }
    );
  }
}
