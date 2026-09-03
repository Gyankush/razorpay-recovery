import { NextRequest, NextResponse } from "next/server";
import { getAuditHistory } from "@/lib/domain/audit";
import { safeJsonParse } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const entity = searchParams.get("entity") || undefined;
    const actor = searchParams.get("actor") || undefined;
    const limit = Number(searchParams.get("limit")) || 50;
    const sinceRaw = searchParams.get("since");
    const untilRaw = searchParams.get("until");
    const since = sinceRaw ? new Date(sinceRaw) : undefined;
    const until = untilRaw ? new Date(untilRaw) : undefined;

    const logs = await getAuditHistory({
      entity,
      actor,
      limit,
      since: since && !Number.isNaN(since.getTime()) ? since : undefined,
      until: until && !Number.isNaN(until.getTime()) ? until : undefined,
    });

    return NextResponse.json({
      success: true,
      count: logs.length,
      logs: logs.map((l) => ({
        ...l,
        before: safeJsonParse(l.beforeJson),
        after: safeJsonParse(l.afterJson),
      })),
    });
  } catch (error) {
    console.error("Error fetching audit logs:", error);
    return NextResponse.json(
      { error: "Failed to fetch audit logs" },
      { status: 500 }
    );
  }
}
