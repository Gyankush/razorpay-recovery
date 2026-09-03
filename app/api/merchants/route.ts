import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { merchants } from "@/db/schema";
import { encryptSecret, maskSecret } from "@/lib/crypto";
import { ensurePolicy } from "@/lib/agent/autopilot";
import { logAuditEvent } from "@/lib/domain/audit";
import { getRequestId, requireAdmin } from "@/lib/http";
import { desc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

/** Lists merchants. Secrets are never returned — only masked fingerprints. */
export async function GET(req: NextRequest) {
  const adminBlock = requireAdmin(req);
  if (adminBlock) return adminBlock;
  try {
    const rows = await db
      .select()
      .from(merchants)
      .orderBy(desc(merchants.createdAt))
      .limit(100);
    return NextResponse.json({
      success: true,
      merchants: rows.map((m) => ({
        id: m.id,
        name: m.name,
        mode: m.mode,
        provider_account_id: m.providerAccountId,
        contact_email: m.contactEmail,
        webhook_url: m.webhookUrl,
        has_own_keys: Boolean(m.encryptedKeyRef),
        timezone: m.timezone,
        created_at: m.createdAt,
      })),
    });
  } catch (error) {
    console.error("Error listing merchants:", error);
    return NextResponse.json({ error: "Failed to list merchants" }, { status: 500 });
  }
}

/**
 * Onboards a merchant: identity + encrypted gateway credentials + routing.
 * Keys are AES-256-GCM encrypted with MASTER_KEY before storage and are
 * never returned by any API (masked fingerprints only).
 */
export async function POST(req: NextRequest) {
  const adminBlock = requireAdmin(req);
  if (adminBlock) return adminBlock;
  const requestId = getRequestId(req, "onboard");

  try {
    const body = await req.json().catch(() => ({}));
    const name = String(body?.name ?? "").trim().slice(0, 255);
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const mode = body?.mode === "live" ? "live" : "test";
    const providerAccountId = body?.provider_account_id
      ? String(body.provider_account_id).slice(0, 100)
      : null;
    const contactEmail = body?.contact_email
      ? String(body.contact_email).slice(0, 255)
      : null;
    const webhookUrl = body?.webhook_url
      ? String(body.webhook_url).slice(0, 2000)
      : null;
    if (webhookUrl && !/^https:\/\//.test(webhookUrl)) {
      return NextResponse.json(
        { error: "webhook_url must be an https URL" },
        { status: 400 }
      );
    }

    const keyId = body?.razorpay_key_id ? String(body.razorpay_key_id) : null;
    const keySecret = body?.razorpay_key_secret ? String(body.razorpay_key_secret) : null;
    const webhookSecret = body?.webhook_secret ? String(body.webhook_secret) : null;

    let encryptedKeyRef: string | null = null;
    if (keyId || keySecret || webhookSecret) {
      if (!keyId || !keySecret) {
        return NextResponse.json(
          { error: "razorpay_key_id and razorpay_key_secret are required together" },
          { status: 400 }
        );
      }
      try {
        encryptedKeyRef = encryptSecret(
          JSON.stringify({ key_id: keyId, key_secret: keySecret, webhook_secret: webhookSecret })
        );
      } catch {
        return NextResponse.json(
          { error: "MASTER_KEY is not configured on the server — cannot store credentials" },
          { status: 503 }
        );
      }
    }

    const [merchant] = await db
      .insert(merchants)
      .values({
        name,
        mode,
        encryptedKeyRef,
        providerAccountId,
        contactEmail,
        webhookUrl,
      })
      .returning();

    await ensurePolicy(merchant.id);

    await logAuditEvent({
      actor: "operator",
      action: "merchant_onboarded",
      entity: "merchant",
      entityId: merchant.id,
      after: {
        name,
        mode,
        provider_account_id: providerAccountId,
        key_id_masked: maskSecret(keyId),
        has_webhook_secret: Boolean(webhookSecret),
      },
      requestId,
    });

    return NextResponse.json({
      success: true,
      merchant: {
        id: merchant.id,
        name: merchant.name,
        mode: merchant.mode,
        provider_account_id: merchant.providerAccountId,
        has_own_keys: Boolean(encryptedKeyRef),
      },
    });
  } catch (error: any) {
    if (error?.code === "23505") {
      return NextResponse.json(
        { error: "provider_account_id is already connected to another merchant" },
        { status: 409 }
      );
    }
    console.error("Error onboarding merchant:", error);
    return NextResponse.json({ error: "Failed to onboard merchant" }, { status: 500 });
  }
}
