import { db } from "@/db";
import { merchants, notifications } from "@/db/schema";
import { eq } from "drizzle-orm";

export interface MerchantNotice {
  merchantId: string;
  caseId?: string | null;
  type: string;
  title: string;
  body: string;
}

/**
 * Durable merchant notification outbox. Inserts the row as `queued`, then
 * attempts one delivery to the merchant's `webhookUrl` (JSON POST, 10s
 * timeout). Without a webhookUrl the row stays `queued` — an honest,
 * auditable outbox — instead of a fake `sent`.
 * Fire-and-forget: callers must not await this on hot paths.
 */
export async function notifyMerchant(n: MerchantNotice): Promise<void> {
  try {
    const [row] = await db
      .insert(notifications)
      .values({
        merchantId: n.merchantId,
        caseId: n.caseId ?? null,
        type: n.type,
        title: n.title.slice(0, 255),
        body: n.body,
        status: "queued",
      })
      .returning();

    const [m] = await db
      .select()
      .from(merchants)
      .where(eq(merchants.id, n.merchantId))
      .limit(1);
    if (!m?.webhookUrl) return; // stays queued: no destination configured

    try {
      const res = await fetch(m.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: n.type,
          title: n.title,
          body: n.body,
          case_id: n.caseId ?? null,
          merchant_id: n.merchantId,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`callback HTTP ${res.status}`);
      await db
        .update(notifications)
        .set({ status: "sent", attempts: 1, sentAt: new Date() })
        .where(eq(notifications.id, row.id));
    } catch (err: any) {
      await db
        .update(notifications)
        .set({
          status: "failed",
          attempts: 1,
          lastError: String(err?.message ?? err).slice(0, 500),
        })
        .where(eq(notifications.id, row.id));
    }
  } catch (err) {
    console.error("[Notify] outbox insert failed:", err);
  }
}
