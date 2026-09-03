import { db } from "@/db";
import { webhookEvents } from "@/db/schema";
import { and, eq, lt } from "drizzle-orm";
import { processPaymentWebhook } from "@/lib/domain/webhook-processor";
import { safeJsonParse } from "@/lib/http";

const SWEEPABLE_PREFIXES = ["payment.", "refund."];

/**
 * Replays stored-but-unprocessed webhook events (missed during an outage,
 * a crash between store and normalize, or a deploy). Only event types the
 * processor understands are retried; anything else stays queued for a human.
 */
export async function sweepStaleWebhooks(
  olderThanMinutes = 5,
  limit = 25
): Promise<{ swept: number; processed: number; failed: number }> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
  const stale = await db
    .select()
    .from(webhookEvents)
    .where(
      and(eq(webhookEvents.processed, false), lt(webhookEvents.receivedAt, cutoff))
    )
    .orderBy(webhookEvents.receivedAt)
    .limit(limit * 2);

  let swept = 0;
  let processed = 0;
  let failed = 0;

  for (const evt of stale) {
    if (swept >= limit) break;
    if (!SWEEPABLE_PREFIXES.some((p) => evt.eventType.startsWith(p))) continue;
    swept += 1;
    try {
      const parsed = safeJsonParse<Record<string, any>>(evt.rawBody) ?? {};
      const outcome = await processPaymentWebhook(
        {
          providerEventId: evt.providerEventId,
          eventType: evt.eventType,
          rawBody: evt.rawBody,
        },
        parsed
      );
      if (outcome === "processed") processed += 1;
    } catch (err) {
      failed += 1;
      console.error(`[Sweeper] replay failed for ${evt.providerEventId}:`, err);
    }
  }

  return { swept, processed, failed };
}
