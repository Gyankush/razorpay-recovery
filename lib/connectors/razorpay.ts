import crypto from "crypto";
import { db } from "@/db";
import {
  recoveryActions,
  paymentCases,
  paymentLinks,
  orders,
  type RecoveryAction,
} from "@/db/schema";
import { getRazorpayClient } from "@/lib/razorpay";
import { getMerchant, resolveMerchantSecrets } from "@/lib/merchants";
import { notifyMerchant } from "@/lib/notify";
import {
  isDemoMode,
  simulatedLinkFor,
  type GatewayLink,
} from "@/lib/gateway";
import { normalizeCurrency, toPositiveInt } from "@/lib/http";
import { eq } from "drizzle-orm";

export interface CreateRecoveryLinkResult {
  success: boolean;
  payment_link_url: string;
  payment_link_id: string;
  action: RecoveryAction;
  already_existed?: boolean;
  simulated?: boolean;
  error?: string;
}

export interface RecoveryLinkOptions {
  /** Public base URL for demo checkout links (defaults to env / localhost). */
  baseUrl?: string;
}

function stableReference(caseId: string, idempotencyKey: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(idempotencyKey)
    .digest("hex")
    .slice(0, 12);
  return `rec_${caseId.replace(/-/g, "").slice(0, 8)}_${hash}`;
}

function resolveBaseUrl(explicit?: string): string {
  return (
    explicit ||
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ||
    "http://localhost:3000"
  );
}

/**
 * Creates an alternate Payment Link for a payment recovery case.
 *
 * Guarantees:
 * - Strict idempotency on `recovery_actions.idempotency_key` via
 *   ON CONFLICT DO NOTHING (safe under concurrent retries).
 * - The action row is created FIRST as `proposed`, so demo checkout URLs
 *   (which embed the action id) always resolve.
 * - The `payment_links` ledger row is written in the same transaction as
 *   the action + case update, so expiry is always enforced downstream.
 * - Real SDK failures are HONEST: the action stays `proposed` with the
 *   error in `result_json`, `success:false` is returned, case left open.
 * - DEMO_MODE forces the simulated driver (demo checkout page) for every
 *   call, even with real keys configured — demos can never move money.
 */
export async function createRecoveryPaymentLink(
  caseId: string,
  amount: number,
  currency: string = "USD",
  idempotencyKey: string,
  approvedBy: string = "operator",
  opts?: RecoveryLinkOptions
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
    const resultJson = existing.resultJson
      ? (JSON.parse(existing.resultJson) as { simulated?: boolean })
      : {};
    return {
      success: existing.status === "executed",
      payment_link_url:
        link?.url ?? `pending://recovery-action/${existing.id}`,
      payment_link_id: link?.providerLinkId ?? `pending_${existing.id.slice(0, 14)}`,
      action: existing,
      already_existed: true,
      simulated: resultJson.simulated === true,
    };
  }

  // 2. Resolve merchant + credentials (per-merchant keys win).
  const [linkedCase] = await db
    .select()
    .from(paymentCases)
    .where(eq(paymentCases.id, caseId))
    .limit(1);
  const [linkedOrder] = linkedCase
    ? await db
        .select()
        .from(orders)
        .where(eq(orders.id, linkedCase.orderId))
        .limit(1)
    : [];
  const merchantIdForNotice = linkedOrder?.merchantId ?? null;
  const secrets = resolveMerchantSecrets(
    linkedOrder ? await getMerchant(linkedOrder.merchantId) : null
  );

  // 3. Claim the idempotency key up-front as `proposed` (race-safe).
  const claimed = await db
    .insert(recoveryActions)
    .values({
      caseId,
      actionType: "create_payment_link",
      status: "proposed",
      idempotencyKey,
      approvedBy,
    })
    .onConflictDoNothing({ target: recoveryActions.idempotencyKey })
    .returning();
  const action =
    claimed[0] ??
    (
      await db
        .select()
        .from(recoveryActions)
        .where(eq(recoveryActions.idempotencyKey, idempotencyKey))
        .limit(1)
    )[0];

  if (claimed.length === 0) {
    // Lost a concurrent race after the fast-path check — return the winner.
    const [link] = await db
      .select()
      .from(paymentLinks)
      .where(eq(paymentLinks.caseId, action.caseId))
      .limit(1);
    return {
      success: action.status === "executed",
      payment_link_url: link?.url ?? `pending://recovery-action/${action.id}`,
      payment_link_id: link?.providerLinkId ?? `pending_${action.id.slice(0, 14)}`,
      action,
      already_existed: true,
    };
  }

  // 4. Mint the link: simulated driver in DEMO_MODE, real SDK otherwise.
  const expireBy = Math.floor(Date.now() / 1000) + 60 * 60; // 60 minutes
  let link: GatewayLink | null = null;
  let sdkError: string | null = null;

  if (isDemoMode()) {
    link = simulatedLinkFor(action.id, resolveBaseUrl(opts?.baseUrl));
    console.log(`[Recovery Executor] DEMO_MODE: simulated link ${link.url}`);
  } else {
    try {
      const razorpay = getRazorpayClient({
        key_id: secrets.keyId,
        key_secret: secrets.keySecret,
      });
      const linkResponse: any = await (razorpay.paymentLink as any).create({
        amount: validAmount,
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

      const plId: string | null = linkResponse?.id ?? null;
      const plUrl: string | null =
        linkResponse?.short_url ??
        (plId ? `https://rzp.io/i/${plId}` : null);
      if (!plUrl || !plId) throw new Error("Razorpay returned an empty payment-link response");
      link = { url: plUrl, id: plId, simulated: false, expiresAt: new Date(expireBy * 1000) };
      console.log(`[Recovery Executor] Razorpay SDK created link: ${plUrl} (${plId})`);
    } catch (err: any) {
      sdkError = err?.message || "Razorpay SDK call failed";
      console.error(`[Recovery Executor] Razorpay API failure: ${sdkError}`);
    }
  }

  // 5a. SDK failure: keep the claimed action `proposed` with the error.
  if (!link) {
    const [failed] = await db
      .update(recoveryActions)
      .set({
        resultJson: JSON.stringify({
          error: sdkError,
          attempted_at: new Date().toISOString(),
        }),
      })
      .where(eq(recoveryActions.id, action.id))
      .returning();
    return {
      success: false,
      payment_link_url: `pending://recovery-action/${action.id}`,
      payment_link_id: `pending_${action.id.slice(0, 14)}`,
      action: failed ?? action,
      already_existed: false,
      error: sdkError ?? "Failed to create recovery payment link",
    };
  }

  // 5b. Success: finalize action + ledger + case atomically.
  const finalized = await db.transaction(async (tx) => {
    const [executed] = await tx
      .update(recoveryActions)
      .set({
        status: "executed",
        executedAt: new Date(),
        resultJson: link!.simulated
          ? JSON.stringify({ simulated: true, demo_checkout: link!.url })
          : null,
      })
      .where(eq(recoveryActions.id, action.id))
      .returning();

    const [stored] = await tx
      .insert(paymentLinks)
      .values({
        caseId,
        providerLinkId: link!.id,
        url: link!.url,
        amount: validAmount as number,
        currency: validCurrency,
        expiry: link!.expiresAt,
        status: "created",
      })
      .returning();

    await tx
      .update(paymentCases)
      .set({
        status: "resolved",
        recommendedAction: `Executed: Created Payment Link (${link!.url})`,
      })
      .where(eq(paymentCases.id, caseId));

    console.log(`[Recovery Executor] Case ${caseId} marked as resolved with action ${action.id}`);
    return { executed, stored };
  });

  if (merchantIdForNotice && finalized.stored) {
    void notifyMerchant({
      merchantId: merchantIdForNotice,
      caseId,
      type: "recovery_link_created",
      title: `Recovery link created for case ${caseId.slice(0, 8)}`,
      body: `Alternate checkout ${finalized.stored.url} (${validCurrency} ${(validAmount / 100).toFixed(2)}, 60-min expiry). Approved by ${approvedBy}.${link.simulated ? " [Demo sandbox — no real money]" : ""}`,
    });
  }

  return {
    success: true,
    payment_link_url: finalized.stored.url,
    payment_link_id: finalized.stored.providerLinkId ?? "",
    action: finalized.executed,
    already_existed: false,
    simulated: link.simulated,
  };
}
