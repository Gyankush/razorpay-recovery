import { NextRequest, NextResponse } from "next/server";
import { runAutopilot } from "@/lib/agent/autopilot";
import { getRequestId, requireAdmin } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Autonomous agent entrypoint — invoked by Vercel Cron every 15 minutes
 * (Bearer CRON_SECRET) or manually by an operator (x-admin-secret).
 * Sweeps enabled autopilot policies, auto-recovers safe cases, runs the
 * reconciliation sweep, and files a full run report in the audit log.
 */
export async function GET(req: NextRequest) {
  const adminBlock = requireAdmin(req);
  if (adminBlock) return adminBlock;
  const requestId = getRequestId(req, "agent");

  try {
    const report = await runAutopilot();
    return NextResponse.json({ success: true, request_id: requestId, report });
  } catch (error) {
    console.error("Autopilot run failed:", error);
    return NextResponse.json(
      { error: "Autopilot run failed" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  return GET(req);
}
