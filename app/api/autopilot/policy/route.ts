import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { autopilotPolicies, merchants } from "@/db/schema";
import {
  ensurePolicy,
  listMerchantsWithPolicies,
  sanitizePolicyUpdate,
} from "@/lib/agent/autopilot";
import { logAuditEvent } from "@/lib/domain/audit";
import { getRequestId, isUuid, requireAdmin, safeJsonParse } from "@/lib/http";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const adminBlock = requireAdmin(req);
  if (adminBlock) return adminBlock;
  try {
    const { searchParams } = new URL(req.url);
    const merchantId = searchParams.get("merchant_id");
    if (merchantId) {
      if (!isUuid(merchantId)) {
        return NextResponse.json({ error: "Valid merchant_id required" }, { status: 400 });
      }
      const policy = await ensurePolicy(merchantId);
      return NextResponse.json({
        success: true,
        policy: {
          ...policy,
          allowed_categories: safeJsonParse(policy.allowedCategories) ?? [],
        },
      });
    }
    const rows = await listMerchantsWithPolicies();
    return NextResponse.json({
      success: true,
      merchants: rows.map(({ merchant, policy }) => ({
        merchant: { id: merchant.id, name: merchant.name, mode: merchant.mode },
        policy: {
          ...policy,
          allowed_categories: safeJsonParse(policy.allowedCategories) ?? [],
        },
      })),
    });
  } catch (error) {
    console.error("Error fetching autopilot policies:", error);
    return NextResponse.json(
      { error: "Failed to fetch policies" },
      { status: 500 }
    );
  }
}

export async function PUT(req: NextRequest) {
  const adminBlock = requireAdmin(req);
  if (adminBlock) return adminBlock;
  const requestId = getRequestId(req, "policy");

  try {
    const body = await req.json().catch(() => ({}));
    const merchantId = body?.merchant_id;
    if (!merchantId || !isUuid(merchantId)) {
      return NextResponse.json({ error: "Valid merchant_id required" }, { status: 400 });
    }
    const [merchant] = await db
      .select()
      .from(merchants)
      .where(eq(merchants.id, merchantId))
      .limit(1);
    if (!merchant) {
      return NextResponse.json({ error: "Merchant not found" }, { status: 404 });
    }

    const checked = sanitizePolicyUpdate({
      enabled: body?.enabled,
      allowed_categories: body?.allowed_categories,
      max_auto_amount: body?.max_auto_amount,
      max_actions_per_run: body?.max_actions_per_run,
      min_confidence: body?.min_confidence,
    });
    if (!checked.ok) {
      return NextResponse.json({ error: checked.error }, { status: 400 });
    }

    const policy = await ensurePolicy(merchantId);
    const [updated] = await db
      .update(autopilotPolicies)
      .set({
        enabled: checked.value!.enabled,
        allowedCategories: JSON.stringify(checked.value!.allowedCategories),
        maxAutoAmount: checked.value!.maxAutoAmount,
        maxActionsPerRun: checked.value!.maxActionsPerRun,
        minConfidence: checked.value!.minConfidence,
        updatedAt: new Date(),
      })
      .where(eq(autopilotPolicies.id, policy.id))
      .returning();

    await logAuditEvent({
      actor: "operator",
      action: checked.value!.enabled ? "autopilot_enabled" : "autopilot_disabled",
      entity: "autopilot_policy",
      entityId: policy.id,
      after: checked.value,
      requestId,
    });

    return NextResponse.json({ success: true, policy: updated });
  } catch (error) {
    console.error("Error updating autopilot policy:", error);
    return NextResponse.json(
      { error: "Failed to update policy" },
      { status: 500 }
    );
  }
}
