import { db } from "@/db";
import { paymentCases, orders, paymentAttempts, recoveryActions, paymentLinks } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { diagnoseFromEntities } from "./diagnose";

function formatAmount(amountCents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format(amountCents / 100);
  } catch {
    return `${(amountCents / 100).toFixed(2)} ${currency}`;
  }
}

export interface SupportPacket {
  case_id: string;
  order_id: string;
  external_order_id: string;
  amount_formatted: string;
  currency: string;
  customer_safe_message: string;
  internal_technical_explanation: string;
  expected_next_event: string;
  escalation_checklist: string[];
  payment_references: {
    provider_payment_id: string | null;
    error_code: string | null;
    timestamp: string;
    alternate_link?: string | null;
  };
}

/**
 * Generates an explainable support packet with customer-safe wording,
 * masked identifiers, and technical root-cause facts for front-line support agents.
 */
export async function generateSupportPacket(caseId: string): Promise<SupportPacket | null> {
  const [c] = await db.select().from(paymentCases).where(eq(paymentCases.id, caseId)).limit(1);
  if (!c) return null;

  const [order] = await db.select().from(orders).where(eq(orders.id, c.orderId)).limit(1);
  const attempts = await db
    .select()
    .from(paymentAttempts)
    .where(eq(paymentAttempts.orderId, c.orderId))
    .orderBy(desc(paymentAttempts.createdAt));

  const latest = attempts[0] || null;
  const actions = await db
    .select()
    .from(recoveryActions)
    .where(eq(recoveryActions.caseId, caseId))
    .orderBy(desc(recoveryActions.createdAt));

  const latestAction = actions[0] || null;
  const diagnosis = diagnoseFromEntities(c, latest, order);

  // Prefer the real ledgered payment link over any reconstruction.
  const [storedLink] = await db
    .select()
    .from(paymentLinks)
    .where(eq(paymentLinks.caseId, caseId))
    .orderBy(desc(paymentLinks.createdAt))
    .limit(1);

  const amountStr = order
    ? formatAmount(order.amount, order.currency)
    : formatAmount(0, "USD");
  const extOrderId = order?.externalOrderId || "N/A";
  const providerPayId = latest?.providerPaymentId || "N/A";
  const alternateLink =
    storedLink?.url ??
    (latestAction && latestAction.status === "executed"
      ? `https://rzp.io/i/rec_${latestAction.id.substring(0, 8)}`
      : null);

  // 1. Customer-Safe Message (Empathetic, clear, no jargon)
  let customerMsg = `Hi there,\n\nThank you for reaching out regarding your order (${extOrderId}).\n\n`;

  if (storedLink?.status === "paid") {
    customerMsg += `Good news — your payment of ${amountStr} has been successfully received and your order is confirmed. No further action is needed on your end.\n\nIf the amount has not yet reflected on your statement, please allow 1-2 business days for your bank to update it.`;
  } else if (storedLink?.status === "expired") {
    customerMsg += `The secure payment link we shared earlier for ${amountStr} has expired unused, and no charge was made. We are preparing a fresh checkout link for you and will share it shortly.\n\nIf you continue to experience issues, we recommend checking with your card issuer to ensure international e-commerce transactions are authorized on your card.`;
  } else if (diagnosis.category === "customer_action") {
    customerMsg += `We noticed your recent payment attempt of ${amountStr} was not completed because the 3D-Secure bank verification challenge was interrupted or timed out. Please rest assured that your card has NOT been charged by us.\n\n`;
    if (alternateLink) {
      customerMsg += `To complete your purchase safely, please use this dedicated secure payment link:\n${alternateLink}\n(Link expires in 60 minutes).\n\n`;
    } else {
      customerMsg += `We are generating a secure alternate checkout link for you and will send it shortly.\n\n`;
    }
    customerMsg += `If you continue to experience issues, we recommend checking with your card issuer to ensure international e-commerce transactions are authorized on your card.`;
  } else if (diagnosis.category === "risk_block") {
    customerMsg += `Your transaction of ${amountStr} was flagged by automated security filters and could not be processed. Your card has not been debited.\n\nFor your security, please try using an alternate payment method or card. If you believe this was in error, our team is reviewing the case (Ref: ${caseId.substring(0, 8)}).`;
  } else {
    customerMsg += `We encountered a temporary processing delay with your payment of ${amountStr}. No successful charge was captured. We are actively monitoring your order and will share an update if any action is needed on your end.`;
  }

  // 2. Internal Technical Explanation (For Engineering / Tier-2)
  const internalExp = `Case #${caseId} | Order ${extOrderId} | Provider Pay ID: ${providerPayId}
Diagnosis: Category = ${diagnosis.category.toUpperCase()} (Confidence: ${(diagnosis.confidence * 100).toFixed(0)}%)
Gateway Error: ${latest?.errorCode || "None"} - ${latest?.errorDescription || "No gateway message"}
Facts: ${diagnosis.facts_used.join(", ")}
Safety Rule: ${diagnosis.do_not_do.join(" | ")}`;

  // 3. Expected Next Event
  const nextEvent = alternateLink
    ? "Awaiting 'payment.captured' webhook from alternate payment link checkout."
    : "Awaiting operator approval to issue alternate payment link.";

  // 4. Escalation Checklist
  const checklist = [
    "Verify no successful payment.captured webhook exists for this order.",
    "Confirm customer bank debit did not result in a settled charge.",
    "Ensure operator has not initiated a redundant manual retry.",
    "If customer claims charge on statement, request bank reference (RRN) before manual resolution.",
  ];

  return {
    case_id: c.id,
    order_id: c.orderId,
    external_order_id: extOrderId,
    amount_formatted: amountStr,
    currency: order?.currency || "USD",
    customer_safe_message: customerMsg,
    internal_technical_explanation: internalExp,
    expected_next_event: nextEvent,
    escalation_checklist: checklist,
    payment_references: {
      provider_payment_id: providerPayId,
      error_code: latest?.errorCode || null,
      timestamp: (latest?.createdAt || c.createdAt).toISOString(),
      alternate_link: alternateLink,
    },
  };
}
