import { NextRequest, NextResponse } from "next/server";
import { runAIEvaluation } from "@/lib/ai/evaluator";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    // Persisting 50 rows per run is opt-in (?persist=true) to avoid
    // flooding the prod eval_cases table on every benchmark click.
    const persist = searchParams.get("persist") === "true";
    const report = await runAIEvaluation({ persist });
    return NextResponse.json({
      success: true,
      persisted: persist,
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
