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
import { eq, and } from "drizzle-orm";

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
 * Updates the payment state and error details for a payment attempt in the database.
 * Matches by attempt UUID or provider_payment_id.
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
  // Check if an open case already exists for this order
  const existingCases = await db
    .select()
    .from(paymentCases)
    .where(
      and(
        eq(paymentCases.orderId, orderId),
        eq(paymentCases.status, "open")
      )
    )
    .limit(1);

  if (existingCases.length > 0) {
    console.log(
      `[Case Engine] Open case already exists for order ${orderId}: ${existingCases[0].id}`
    );
    return existingCases[0];
  }

  // Determine failure category and recommended safe recovery action
  const rLower = (reason || "").toLowerCase();
  const category =
    failureCategory ||
    (rLower.includes("3ds") ||
    rLower.includes("authentication") ||
    rLower.includes("otp") ||
    rLower.includes("challenge") ||
    rLower.includes("verification") ||
    rLower.includes("abandoned")
      ? "customer_action_required"
      : rLower.includes("risk") ||
        rLower.includes("fraud") ||
        rLower.includes("blocked") ||
        rLower.includes("suspicious")
      ? "risk_block"
      : rLower.includes("decline") ||
        rLower.includes("insufficient") ||
        rLower.includes("honor")
      ? "issuer_decline"
      : "gateway_failure");

  const plainExplanation =
    reason ||
    "The payment attempt failed without a capture event. International card verification may have dropped off.";

  const recommendedAction =
    category === "customer_action_required"
      ? "send_alternate_payment_link"
      : "escalate_to_customer";

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

  return newCase;
}

/**
 * Helper to ensure a merchant and order exist for incoming webhook events
 * so foreign key constraints are satisfied.
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
    const [created] = await db
      .insert(merchants)
      .values({
        name: "PayRescue Primary Merchant",
        mode: "test",
      })
      .returning();
    defaultMerchant = created;
  }

  // Create the order
  const [createdOrder] = await db
    .insert(orders)
    .values({
      merchantId: defaultMerchant.id,
      externalOrderId,
      amount,
      currency: currency.toUpperCase(),
      status: "pending",
    })
    .returning();

  return createdOrder;
}
