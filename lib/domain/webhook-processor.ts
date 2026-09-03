import { db } from "@/db";
import {
  webhookEvents,
  paymentAttempts,
  paymentCases,
  paymentLinks,
  type Merchant,
} from "@/db/schema";
import { eq, and } from "drizzle-orm";
import {
  mapRazorpayEventToCanonicalState,
  updatePaymentState,
  openOrUpdateCase,
  ensureOrderForWebhook,
} from "@/lib/domain/normalizer";
import { findMerchantByAccountId, resolveMerchantSecrets } from "@/lib/merchants";
import { notifyMerchant } from "@/lib/notify";
import { normalizeCurrency } from "@/lib/http";

export type WebhookOutcome =
  | "processed"
  | "stored_unprocessable"
  | "stored_deferred";

export interface StoredWebhook {
  providerEventId: string;
  eventType: string;
  rawBody: string;
}

/**
 * Resolves which secret authenticates a webhook: the owning merchant's own
 * webhook secret (matched by payload `account_id`), else the global env.
 * Returns null when neither exists (caller must 401).
 */
export async function resolveWebhookSecret(
  parsedBody: Record<string, any>
): Promise<{ secret: string | null; merchant: Merchant | null }> {
  const accountId: string | undefined =
    parsedBody?.account_id || parsedBody?.payload?.account_id;
  const merchant = accountId
    ? await findMerchantByAccountId(String(accountId))
    : null;
  const secrets = resolveMerchantSecrets(merchant);
  return { secret: secrets.webhookSecret, merchant };
}

/**
 * Normalizes one stored webhook event: upserts the payment attempt,
 * opens/updates the payment case, matches link payments to mark them paid.
 * Idempotent: replays converge (state guard + ON CONFLICT + case dedupe).
 */
export async function processPaymentWebhook(
  stored: StoredWebhook,
  parsedBody: Record<string, any>
): Promise<WebhookOutcome> {
  const { providerEventId, eventType } = stored;
  const canonicalState = mapRazorpayEventToCanonicalState(eventType);
  const paymentEntity = parsedBody?.payload?.payment?.entity;

  if (paymentEntity) {
    const providerPaymentId = paymentEntity.id;
    if (!providerPaymentId) return "stored_unprocessable";

    const externalOrderId =
      paymentEntity.order_id ||
      parsedBody?.payload?.order?.entity?.id ||
      `order_ext_${providerPaymentId}`;

    const rawAmount = Number(paymentEntity.amount);
    if (!Number.isFinite(rawAmount) || rawAmount < 0) {
      return "stored_unprocessable";
    }
    const amount = Math.floor(rawAmount);
    const currency = normalizeCurrency(paymentEntity.currency, "USD");
    const errorCode = paymentEntity.error_code || null;
    const errorDescription =
      paymentEntity.error_description || paymentEntity.error_reason || null;

    const order = await ensureOrderForWebhook(externalOrderId, amount, currency);

    let attempt = await updatePaymentState(
      providerPaymentId,
      canonicalState,
      errorCode,
      errorDescription
    );

    if (!attempt) {
      const [createdAttempt] = await db
        .insert(paymentAttempts)
        .values({
          orderId: order.id,
          providerPaymentId,
          status: canonicalState,
          errorCode,
          errorDescription,
        })
        .onConflictDoNothing({
          target: paymentAttempts.providerPaymentId,
        })
        .returning();
      attempt =
        createdAttempt ??
        (
          await db
            .select()
            .from(paymentAttempts)
            .where(eq(paymentAttempts.providerPaymentId, providerPaymentId))
            .limit(1)
        )[0] ??
        null;
    }

    if (attempt && canonicalState === "failed" && attempt.status === "failed") {
      const reason = errorDescription || errorCode || "Payment failed at gateway";
      await openOrUpdateCase(order.id, attempt.id, reason);
    }

    // Link lifecycle: a captured/settled payment arriving through a recovery
    // link (matched by Razorpay link id) marks the link PAID and closes the
    // loop with a merchant notification. Exact id match only — never guess.
    if (
      attempt &&
      (canonicalState === "captured" || canonicalState === "settled")
    ) {
      const linkEntityId: string | undefined =
        parsedBody?.payload?.payment_link?.entity?.id;
      if (linkEntityId) {
        const [link] = await db
          .select()
          .from(paymentLinks)
          .where(eq(paymentLinks.providerLinkId, String(linkEntityId)))
          .limit(1);
        if (link && link.status !== "paid") {
          await db
            .update(paymentLinks)
            .set({ status: "paid" })
            .where(eq(paymentLinks.id, link.id));
          await db
            .update(paymentCases)
            .set({
              status: "resolved",
              recommendedAction: `Paid via recovery link (${link.url})`,
            })
            .where(eq(paymentCases.id, link.caseId));
          void notifyMerchant({
            merchantId: order.merchantId,
            caseId: link.caseId,
            type: "recovery_link_paid",
            title: `Recovery link paid (case ${link.caseId.slice(0, 8)})`,
            body: `Customer completed the alternate checkout. Gateway link ${linkEntityId} captured ${(amount / 100).toFixed(2)} ${currency}.`,
          });
        }
      }
    }

    await db
      .update(webhookEvents)
      .set({ processed: true })
      .where(eq(webhookEvents.providerEventId, providerEventId));
    return "processed";
  }

  if (eventType.startsWith("refund.")) {
    const refundEntity =
      parsedBody?.payload?.refund?.entity ?? parsedBody?.payload?.payment?.entity;
    const refundPaymentId = refundEntity?.payment_id ?? refundEntity?.id ?? null;
    if (refundPaymentId) {
      await updatePaymentState(
        String(refundPaymentId),
        "refunded",
        refundEntity?.error_code ?? "REFUND_PROCESSED",
        refundEntity?.error_description ?? "Refund processed at gateway"
      );
      await db
        .update(webhookEvents)
        .set({ processed: true })
        .where(eq(webhookEvents.providerEventId, providerEventId));
      return "processed";
    }
    console.warn(
      `[Webhook Processor] refund event ${providerEventId} has no identifiable payment; leaving unprocessed for manual review`
    );
    return "stored_deferred";
  }

  console.warn(
    `[Webhook Processor] event ${providerEventId} (${eventType}) stored without a payment entity; leaving unprocessed`
  );
  return "stored_deferred";
}
