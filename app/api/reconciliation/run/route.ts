import { NextResponse } from "next/server";
import { runReconciliationEngine } from "@/lib/domain/reconciliation";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const summary = await runReconciliationEngine();
    return NextResponse.json({
      success: true,
      summary: {
        ...summary,
        total_difference_formatted: `$${(summary.total_difference / 100).toFixed(2)}`,
      },
    });
  } catch (error) {
    console.error("Error executing reconciliation engine:", error);
    return NextResponse.json(
      { error: "Failed to run reconciliation engine" },
      { status: 500 }
    );
  }
}
