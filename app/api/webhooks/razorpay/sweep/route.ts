import { NextRequest, NextResponse } from "next/server";
import { sweepStaleWebhooks } from "@/lib/domain/webhook-sweeper";
import { logAuditEvent } from "@/lib/domain/audit";
import { getRequestId, requireAdmin, toPositiveInt } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Replays stored-but-unprocessed webhook events (missed during outages).
 * Admin/cron only. Safe to run on a schedule — replays converge.
 */
export async function POST(req: NextRequest) {
  const adminBlock = requireAdmin(req);
  if (adminBlock) return adminBlock;
  const requestId = getRequestId(req, "sweep");

  try {
    const body = await req.json().catch(() => ({}));
    const limit = Math.min(toPositiveInt(body?.limit) ?? 25, 100);
    const result = await sweepStaleWebhooks(5, limit);
    await logAuditEvent({
      actor: "sweeper",
      action: "webhook_sweep_completed",
      entity: "webhook_sweep",
      after: result,
      requestId,
    });
    return NextResponse.json({ success: true, request_id: requestId, ...result });
  } catch (error) {
    console.error("Webhook sweep failed:", error);
    return NextResponse.json({ error: "Sweep failed" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return POST(req);
}
