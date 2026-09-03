import { NextRequest, NextResponse } from "next/server";
import { getAuditHistory } from "@/lib/domain/audit";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const entity = searchParams.get("entity") || undefined;
    const actor = searchParams.get("actor") || undefined;
    const limit = Number(searchParams.get("limit")) || 50;

    const logs = await getAuditHistory({ entity, actor, limit });

    return NextResponse.json({
      success: true,
      count: logs.length,
      logs: logs.map((l) => ({
        ...l,
        before: l.beforeJson ? JSON.parse(l.beforeJson) : null,
        after: l.afterJson ? JSON.parse(l.afterJson) : null,
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
