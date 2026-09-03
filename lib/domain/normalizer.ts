import { db } from "@/db";
import {
  paymentAttempts,
  paymentCases,
  orders,
  merchants,
  type PaymentAttemptStatus,
  type PaymentAttempt,
  type PaymentCase,
} from "@/db/schema";
import { eq, and, or } from "drizzle-orm";

/**
 * Converts Razorpay webhook event strings or gateway status strings
 * to canonical database enum states.
 *
 * Canonical states:
 * - payment.authorized -> authorized
 * - payment.captured   -> captured
 * - payment.failed     -> failed
 * - refund.processed   -> refunded
 * - settlement.processed -> settled
 */
export function mapRazorpayEventToCanonicalState(
  eventTypeOrStatus: string
): PaymentAttemptStatus {
  const normalized = eventTypeOrStatus.toLowerCase().trim();

  switch (normalized) {
    case "payment.authorized":
    case "authorized":
      return "authorized";

    case "payment.captured":
    case "captured":
      return "captured";

    case "payment.failed":
    case "failed":
      return "failed";

    case "refund.processed":
    case "refunded":
      return "refunded";

    case "settlement.processed":
    case "settled":
      return "settled";

    case "payment.created":
    case "initiated":
    case "created":
      return "initiated";

    default:
      return "unknown";
  }
}

/**
 * Canonical state-machine guard: terminal gateway states must never regress.
 * - `captured` may only advance to `settled` / `refunded`.
 * - `settled` / `refunded` are terminal (refunds are recorded, not regressed).
 * - A known state is never overwritten by `unknown` (stale/ambiguous event).
 * - `failed` may advance to `captured` / `settled` (late success) but never
 *   silently regress a captured payment.
 */
export function isAllowedTransition(
  from: PaymentAttemptStatus,
  to: PaymentAttemptStatus
): boolean {
  if (from === to) return true;
  if (from === "unknown") return true;
  if (to === "unknown") return false;
  if (from === "settled" || from === "refunded") return false;
  if (from === "captured") return to === "settled" || to === "refunded";
  if (from === "failed") return to !== "initiated";
  return true;
}

/**
 * Updates the payment state and error details for a payment attempt in the database.
 * Matches by attempt UUID or provider_payment_id.
 * Stale out-of-order events that would regress a terminal state are ignored
 * (the stored row is returned unchanged) instead of corrupting payment truth.
 *
 * @param attemptId - UUID of the attempt or provider payment ID (e.g., pay_xxx)
 * @param newState - Canonical PaymentAttemptStatus
 * @param errorCode - Gateway error code if available
 * @param errorDescription - Detailed error description if available
 */
export async function updatePaymentState(
  attemptId: string,
  newState: PaymentAttemptStatus,
  errorCode?: string | null,
  errorDescription?: string | null
): Promise<PaymentAttempt | null> {
  // Check if attempt exists by id (UUID) or providerPaymentId
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      attemptId
    );

  const condition = isUuid
    ? eq(paymentAttempts.id, attemptId)
    : eq(paymentAttempts.providerPaymentId, attemptId);

  const existing = await db
    .select()
    .from(paymentAttempts)
    .where(condition)
    .limit(1);

  if (existing.length > 0) {
    const current = existing[0];
    if (!isAllowedTransition(current.status, newState)) {
      console.log(
        `[State Machine] Ignored stale event ${current.status} -> ${newState} for attempt ${current.id}`
      );
      return current;
    }
    const [updated] = await db
      .update(paymentAttempts)
      .set({
        status: newState,
        errorCode: errorCode !== undefined ? errorCode : existing[0].errorCode,
        errorDescription:
          errorDescription !== undefined
            ? errorDescription
            : existing[0].errorDescription,
      })
      .where(eq(paymentAttempts.id, existing[0].id))
      .returning();

    return updated;
  }

  return null;
}

/**
 * Opens or updates a payment case for an order.
 * If a payment fails, it inserts a new row into `payment_cases` (status = 'open')
 * if one does not already exist for that order.
 *
 * @param orderId - UUID of the order
 * @param attemptId - UUID of the failed attempt (optional context)
 * @param reason - Plain text or error description
 * @param failureCategory - Categorization (customer_action, issuer_decline, transient, etc.)
 */
export async function openOrUpdateCase(
  orderId: string,
  attemptId?: string | null,
  reason?: string | null,
  failureCategory?: string | null
): Promise<PaymentCase> {
  // Dedupe across every unresolved state: a second failure for the same order
  // must not open a second case while one is already open or action_required.
  const existingCases = await db
    .select()
    .from(paymentCases)
    .where(
      and(
        eq(paymentCases.orderId, orderId),
        or(
          eq(paymentCases.status, "open"),
          eq(paymentCases.status, "action_required")
        )
      )
    )
    .limit(1);

  if (existingCases.length > 0) {
    console.log(
      `[Case Engine] Open case already exists for order ${orderId}: ${existingCases[0].id}`
    );
    return existingCases[0];
  }

  // Determine failure category using the shared AI-diagnose taxonomy
  // (customer_action / risk_block / unknown) so stored cases, the diagnose
  // engine, dashboards and eval benchmarks all speak the same language.
  const rLower = (reason || "").toLowerCase();
  const rawCategory =
    failureCategory ||
    (rLower.includes("3ds") ||
    rLower.includes("authentication") ||
    rLower.includes("otp") ||
    rLower.includes("challenge") ||
    rLower.includes("verification") ||
    rLower.includes("abandoned")
      ? "customer_action"
      : rLower.includes("risk") ||
        rLower.includes("fraud") ||
        rLower.includes("blocked") ||
        rLower.includes("suspicious")
      ? "risk_block"
      : rLower.includes("decline") ||
        rLower.includes("insufficient") ||
        rLower.includes("honor")
      ? "customer_action"
      : "unknown");

  // Back-compat: map legacy caller labels onto the shared taxonomy.
  const category =
    rawCategory === "customer_action_required" ||
    rawCategory === "issuer_decline"
      ? "customer_action"
      : rawCategory === "gateway_failure"
      ? "unknown"
      : rawCategory;

  const plainExplanation =
    reason ||
    "The payment attempt failed without a capture event. International card verification may have dropped off.";

  const recommendedAction =
    category === "customer_action"
      ? "send_alternate_payment_link"
      : "escalate_support";

  // Insert new case with status = 'open'
  const [newCase] = await db
    .insert(paymentCases)
    .values({
      orderId,
      status: "open",
      failureCategory: category,
      confidence: "0.88",
      plainExplanation,
      recommendedAction,
    })
    .returning();

  console.log(
    `[Case Engine] Opened new payment case ${newCase.id} for order ${orderId}`
  );

  // Tell the merchant in real time (durable outbox; fire-and-forget).
  const [caseOrder] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  if (caseOrder) {
    const { notifyMerchant } = await import("@/lib/notify");
    void notifyMerchant({
      merchantId: caseOrder.merchantId,
      caseId: newCase.id,
      type: "case_opened",
      title: `Payment case opened (${category})`,
      body: `${plainExplanation} Recommended: ${recommendedAction}. Order ${caseOrder.externalOrderId} ${(caseOrder.amount / 100).toFixed(2)} ${caseOrder.currency}.`,
    });
  }

  return newCase;
}

/**
 * Helper to ensure a merchant and order exist for incoming webhook events
 * so foreign key constraints are satisfied. Race-safe: concurrent webhooks
 * for the same order converge on one row via ON CONFLICT DO NOTHING.
 */
export async function ensureOrderForWebhook(
  externalOrderId: string,
  amount: number = 0,
  currency: string = "USD"
) {
  // Check if order exists
  const existingOrders = await db
    .select()
    .from(orders)
    .where(eq(orders.externalOrderId, externalOrderId))
    .limit(1);

  if (existingOrders.length > 0) {
    return existingOrders[0];
  }

  // Ensure a default merchant exists
  let defaultMerchant = (
    await db.select().from(merchants).limit(1)
  )[0];

  if (!defaultMerchant) {
    const created = await db
      .insert(merchants)
      .values({
        name: "PayRescue Primary Merchant",
        mode: "test",
      })
      .onConflictDoNothing()
      .returning();
    defaultMerchant =
      created[0] ?? (await db.select().from(merchants).limit(1))[0];
  }

  // Create the order (a concurrent webhook may win the race — reuse its row)
  const createdOrders = await db
    .insert(orders)
    .values({
      merchantId: defaultMerchant.id,
      externalOrderId,
      amount,
      currency: currency.toUpperCase(),
      status: "pending",
    })
    .onConflictDoNothing({ target: orders.externalOrderId })
    .returning();

  if (createdOrders.length > 0) return createdOrders[0];

  const [winner] = await db
    .select()
    .from(orders)
    .where(eq(orders.externalOrderId, externalOrderId))
    .limit(1);
  return winner;
}
