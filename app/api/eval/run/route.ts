import { NextResponse } from "next/server";
import { runAIEvaluation } from "@/lib/ai/evaluator";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const report = await runAIEvaluation();
    return NextResponse.json({
      success: true,
      report,
    });
  } catch (error) {
    console.error("Error executing AI benchmark evaluation:", error);
    return NextResponse.json(
      { error: "Failed to run AI evaluation" },
      { status: 500 }
    );
  }
}
