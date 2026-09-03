import crypto from "crypto";
import { db } from "@/db";
import {
  recoveryActions,
  paymentCases,
  paymentLinks,
  type RecoveryAction,
} from "@/db/schema";
import { getRazorpayClient } from "@/lib/razorpay";
import { normalizeCurrency, toPositiveInt } from "@/lib/http";
import { eq } from "drizzle-orm";

export interface CreateRecoveryLinkResult {
  success: boolean;
  payment_link_url: string;
  payment_link_id: string;
  action: RecoveryAction;
  already_existed?: boolean;
  error?: string;
}

function stableReference(caseId: string, idempotencyKey: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(idempotencyKey)
    .digest("hex")
    .slice(0, 12);
  return `rec_${caseId.replace(/-/g, "").slice(0, 8)}_${hash}`;
}

/**
 * Creates an alternate Payment Link for a payment recovery case.
 *
 * Guarantees:
 * - Strict idempotency on `recovery_actions.idempotency_key` via
 *   ON CONFLICT DO NOTHING (safe under concurrent retries).
 * - The `payment_links` ledger row is written in the same transaction as
 *   the action + case update, so expiry is always enforced downstream.
 * - Razorpay SDK failures are HONEST: the action is recorded as `proposed`
 *   with the error in `result_json`, `success:false` is returned, and the
 *   case is left open. No fake URLs, no false `resolved` states.
 */
export async function createRecoveryPaymentLink(
  caseId: string,
  amount: number,
  currency: string = "USD",
  idempotencyKey: string,
  approvedBy: string = "operator"
): Promise<CreateRecoveryLinkResult> {
  const validAmount = toPositiveInt(amount);
  if (!validAmount) {
    throw new Error(`Invalid recovery amount: ${amount}`);
  }
  const validCurrency = normalizeCurrency(currency);
  if (!idempotencyKey || idempotencyKey.length < 8) {
    throw new Error("idempotency_key is required (min 8 chars)");
  }

  // 1. Fast-path idempotency check
  const existingActions = await db
    .select()
    .from(recoveryActions)
    .where(eq(recoveryActions.idempotencyKey, idempotencyKey))
    .limit(1);

  if (existingActions.length > 0) {
    const existing = existingActions[0];
    const [link] = await db
      .select()
      .from(paymentLinks)
      .where(eq(paymentLinks.caseId, existing.caseId))
      .limit(1);
    console.log(
      `[Recovery Executor] Idempotent hit: action ${existing.id} already exists for key ${idempotencyKey}`
    );
    return {
      success: existing.status === "executed",
      payment_link_url:
        link?.url ?? `pending://recovery-action/${existing.id}`,
      payment_link_id: link?.providerLinkId ?? `pending_${existing.id.slice(0, 14)}`,
      action: existing,
      already_existed: true,
    };
  }

  // 2. Call Razorpay SDK (no silent fallback to fake links)
  const expireBy = Math.floor(Date.now() / 1000) + 60 * 60; // 60 minutes
  let paymentLinkUrl: string | null = null;
  let paymentLinkId: string | null = null;
  let sdkError: string | null = null;

  try {
    const razorpay = getRazorpayClient();
    const linkResponse: any = await (razorpay.paymentLink as any).create({
      amount: validAmount, // lowest currency unit (cents / paise)
      currency: validCurrency.toUpperCase(),
      accept_partial: false,
      description: `PayRescue Recovery: Alternate checkout for Case ${caseId.substring(0, 8)}`,
      reference_id: stableReference(caseId, idempotencyKey),
      expire_by: expireBy,
      reminder_enable: false,
      notes: {
        case_id: caseId,
        recovery_type: "alternate_payment_link",
        idempotency_key: idempotencyKey,
      },
    });

    paymentLinkId = linkResponse?.id ?? null;
    paymentLinkUrl =
      linkResponse?.short_url ??
      (paymentLinkId ? `https://rzp.io/i/${paymentLinkId}` : null);
    if (!paymentLinkUrl || !paymentLinkId) {
      throw new Error("Razorpay returned an empty payment-link response");
    }
    console.log(
      `[Recovery Executor] Razorpay SDK created link: ${paymentLinkUrl} (${paymentLinkId})`
    );
  } catch (err: any) {
    sdkError = err?.message || "Razorpay SDK call failed";
    console.error(`[Recovery Executor] Razorpay API failure: ${sdkError}`);
  }

  // 3. SDK failure: record honestly, keep the case open
  if (!paymentLinkUrl || !paymentLinkId) {
    const rows = await db
      .insert(recoveryActions)
      .values({
        caseId,
        actionType: "create_payment_link",
        status: "proposed",
        idempotencyKey,
        approvedBy,
        resultJson: JSON.stringify({ error: sdkError, attempted_at: new Date().toISOString() }),
      })
      .onConflictDoNothing({ target: recoveryActions.idempotencyKey })
      .returning();

    const action =
      rows[0] ??
      (
        await db
          .select()
          .from(recoveryActions)
          .where(eq(recoveryActions.idempotencyKey, idempotencyKey))
          .limit(1)
      )[0];

    return {
      success: false,
      payment_link_url: `pending://recovery-action/${action.id}`,
      payment_link_id: `pending_${action.id.slice(0, 14)}`,
      action,
      already_existed: rows.length === 0,
      error: sdkError ?? "Failed to create recovery payment link",
    };
  }

  // 4. Success: action + payment_links ledger + case resolution, atomically
  const result = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(recoveryActions)
      .values({
        caseId,
        actionType: "create_payment_link",
        status: "executed",
        idempotencyKey,
        approvedBy,
        executedAt: new Date(),
      })
      .onConflictDoNothing({ target: recoveryActions.idempotencyKey })
      .returning();

    if (inserted.length === 0) {
      // Lost a concurrent race: return the winner's rows
      const [winner] = await tx
        .select()
        .from(recoveryActions)
        .where(eq(recoveryActions.idempotencyKey, idempotencyKey))
        .limit(1);
      const [winnerLink] = await tx
        .select()
        .from(paymentLinks)
        .where(eq(paymentLinks.caseId, winner.caseId))
        .limit(1);
      return { action: winner, url: winnerLink?.url ?? "", id: winnerLink?.providerLinkId ?? "", raced: true as const };
    }

    const action = inserted[0];
    const [link] = await tx
      .insert(paymentLinks)
      .values({
        caseId,
        providerLinkId: paymentLinkId as string,
        url: paymentLinkUrl as string,
        amount: validAmount as number,
        currency: validCurrency,
        expiry: new Date(expireBy * 1000),
        status: "created",
      })
      .returning();

    await tx
      .update(paymentCases)
      .set({
        status: "resolved",
        recommendedAction: `Executed: Created Payment Link (${paymentLinkUrl})`,
      })
      .where(eq(paymentCases.id, caseId));

    console.log(
      `[Recovery Executor] Case ${caseId} marked as resolved with action ${action.id}`
    );
    return { action, url: link.url, id: link.providerLinkId ?? "", raced: false as const };
  });

  return {
    success: true,
    payment_link_url: result.url,
    payment_link_id: result.id,
    action: result.action,
    already_existed: result.raced,
  };
}
