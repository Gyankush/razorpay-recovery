import { NextRequest, NextResponse } from "next/server";
import { getReconciliationExceptions } from "@/lib/domain/reconciliation";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const filter = searchParams.get("status") as "discrepancy" | "pending" | "matched" | null;

    const items = await getReconciliationExceptions(filter || undefined);

    const discrepancyCount = items.filter((i) => i.status === "discrepancy").length;
    const pendingCount = items.filter((i) => i.status === "pending").length;
    const matchedCount = items.filter((i) => i.status === "matched").length;

    return NextResponse.json({
      success: true,
      total_items: items.length,
      discrepancy_count: discrepancyCount,
      pending_count: pendingCount,
      matched_count: matchedCount,
      items: items.map((i) => ({
        ...i,
        expected_formatted: (i.expected / 100).toFixed(2),
        actual_formatted: (i.actual / 100).toFixed(2),
        difference_formatted: (i.difference / 100).toFixed(2),
      })),
    });
  } catch (error) {
    console.error("Error fetching reconciliation exceptions:", error);
    return NextResponse.json(
      { error: "Failed to fetch reconciliation exceptions" },
      { status: 500 }
    );
  }
}
