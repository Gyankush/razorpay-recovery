import { NextRequest, NextResponse } from "next/server";
import { getAutopilotBrief } from "@/lib/agent/autopilot";
import { requireAdmin } from "@/lib/http";

export const dynamic = "force-dynamic";

/** AI copilot brief: 24h activity, 7d recovery rate, backlog anomalies. */
export async function GET(req: NextRequest) {
  const adminBlock = requireAdmin(req);
  if (adminBlock) return adminBlock;
  try {
    const brief = await getAutopilotBrief();
    return NextResponse.json({ success: true, brief });
  } catch (error) {
    console.error("Error building autopilot brief:", error);
    return NextResponse.json(
      { error: "Failed to build brief" },
      { status: 500 }
    );
  }
}
