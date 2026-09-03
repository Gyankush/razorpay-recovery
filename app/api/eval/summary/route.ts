import { NextResponse } from "next/server";
import { db } from "@/db";
import { evalCases } from "@/db/schema";
import { desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const recent = await db
      .select()
      .from(evalCases)
      .orderBy(desc(evalCases.createdAt))
      .limit(50);

    const total = recent.length;
    const scoredFull = recent.filter((r) => Number(r.score) >= 1.0).length;
    const accuracy = total > 0 ? Math.round((scoredFull / total) * 100) : 0;

    return NextResponse.json({
      success: true,
      total_benchmark_records: total,
      accuracy_percentage: accuracy,
      recent_cases: recent.map((r) => ({
        ...r,
        input: JSON.parse(r.inputJson),
        actual: r.actualJson ? JSON.parse(r.actualJson) : null,
      })),
    });
  } catch (error) {
    console.error("Error fetching eval summary:", error);
    return NextResponse.json(
      { error: "Failed to fetch evaluation summary" },
      { status: 500 }
    );
  }
}
