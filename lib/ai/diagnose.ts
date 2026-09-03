import type { PaymentAttempt, Order, PaymentCase } from "@/db/schema";

export type FailureCategory =
  | "transient"
  | "customer_action"
  | "eligibility"
  | "risk_block"
  | "merchant_config"
  | "finance_exception"
  | "unknown";

export type RecommendedAction =
  | "send_alternate_payment_link"
  | "cooldown_retry"
  | "escalate_support"
  | "none";

export interface DiagnosisResult {
  category: FailureCategory;
  confidence: number;
  facts_used: string[];
  explanation: string;
  recommended_action: RecommendedAction;
  do_not_do: string[];
  stopping_rule: string;
  needs_human_approval: boolean;
}

export interface DiagnosisInput {
  errorCode?: string | null;
  errorDescription?: string | null;
  currency?: string | null;
  amount?: number | null;
  attemptStatus?: string | null;
  attemptAgeMinutes?: number | null;
  hasCaptureEvent?: boolean;
}

/**
 * Deterministic AI Diagnostic Rule Engine:
 * Analyzes payment attempts, error codes, and gateway descriptions to output
 * a structured, explainable diagnosis following the PayRescue PRD contract.
 */
export function diagnosePaymentFailure(input: DiagnosisInput): DiagnosisResult {
  const code = (input.errorCode || "").toUpperCase();
  const desc = (input.errorDescription || "").toLowerCase();
  const currency = (input.currency || "USD").toUpperCase();
  const isInternational = currency !== "INR";

  const facts: string[] = [];
  if (isInternational) {
    facts.push(`cross_border_currency_${currency}`);
  }
  if (!input.hasCaptureEvent) {
    facts.push("no_capture_event_observed");
  }

  // 1. 3DS / Authentication / Customer Drop-off
  const is3DSorAuth =
    code.includes("3DS") ||
    code.includes("BAD_REQUEST_ERROR") ||
    desc.includes("3d") ||
    desc.includes("otp") ||
    desc.includes("authentication") ||
    desc.includes("challenge") ||
    desc.includes("verification") ||
    desc.includes("abandoned");

  if (is3DSorAuth) {
    facts.push("3ds_or_issuer_challenge_incomplete");
    facts.push("gateway_status_failed_non_fatal");
    if (code) facts.push(`error_code_${code}`);

    return {
      category: "customer_action",
      confidence: 0.88,
      facts_used: facts,
      explanation:
        "The payment was not captured because the 3D-Secure or cardholder authentication step was not completed. The customer likely dropped off or the issuing bank required an SMS/app verification that expired.",
      recommended_action: "send_alternate_payment_link",
      do_not_do: [
        "blind_retry_same_card",
        "mark_order_paid",
        "blame_the_customer",
        "issue_premature_refund",
      ],
      stopping_rule:
        "Stop after generating 1 alternate payment link or when a verified capture webhook is received.",
      needs_human_approval: true,
    };
  }

  // 2. Risk / Fraud Block
  const isRiskBlock =
    code.includes("RISK") ||
    code.includes("FRAUD") ||
    code.includes("BLOCKED") ||
    desc.includes("risk") ||
    desc.includes("fraud") ||
    desc.includes("suspicious") ||
    desc.includes("blacklisted");

  if (isRiskBlock) {
    facts.push("gateway_or_issuer_risk_flag");
    if (code) facts.push(`error_code_${code}`);

    return {
      category: "risk_block",
      confidence: 0.95,
      facts_used: facts,
      explanation:
        "This payment attempt was blocked by automated risk rules. The gateway or issuer detected anomalous transaction attributes or strict velocity checks.",
      recommended_action: "escalate_support",
      do_not_do: [
        "bypass_risk_rules",
        "retry_charge_immediately",
        "coach_cardholder_to_evade_checks",
      ],
      stopping_rule: "Never retry autonomously. Require manual risk review.",
      needs_human_approval: true,
    };
  }

  // 3. Issuer Decline / Do Not Honor
  const isIssuerDecline =
    code.includes("GATEWAY_ERROR") ||
    code.includes("DECLINED") ||
    code.includes("DO_NOT_HONOR") ||
    code.includes("INSUFFICIENT_FUNDS") ||
    desc.includes("decline") ||
    desc.includes("honor") ||
    desc.includes("insufficient");

  if (isIssuerDecline) {
    facts.push("issuer_explicit_decline");
    if (code) facts.push(`error_code_${code}`);

    return {
      category: "customer_action",
      confidence: 0.92,
      facts_used: facts,
      explanation:
        "The issuing bank declined the transaction. Cross-border e-commerce may be disabled by default on this card, or funds were insufficient. Retrying the identical card will fail.",
      recommended_action: "send_alternate_payment_link",
      do_not_do: [
        "blind_retry_same_card",
        "alter_ledger_status",
        "assume_payment_success",
      ],
      stopping_rule:
        "Offer 1 alternate payment method link; prompt customer to authorize international payments with their bank.",
      needs_human_approval: true,
    };
  }

  // 4. Transient / Network Timeout
  const isTransient =
    code.includes("TIMEOUT") ||
    code.includes("SERVER_ERROR") ||
    code.includes("NETWORK") ||
    desc.includes("timeout") ||
    desc.includes("temporary") ||
    desc.includes("unavailable");

  if (isTransient) {
    facts.push("network_or_gateway_timeout");
    if (code) facts.push(`error_code_${code}`);

    return {
      category: "transient",
      confidence: 0.82,
      facts_used: facts,
      explanation:
        "A network timeout or temporary bank gateway glitch occurred before authorization completed.",
      recommended_action: "cooldown_retry",
      do_not_do: [
        "rapid_retry_loop",
        "mark_order_abandoned",
        "double_charge_customer",
      ],
      stopping_rule:
        "Wait 5-15 minutes cooldown before 1 single retry, then switch to alternate link.",
      needs_human_approval: true,
    };
  }

  // 5. Merchant Config / Currency / Eligibility
  const isConfigOrEligibility =
    code.includes("CURRENCY_NOT_SUPPORTED") ||
    code.includes("INTERNATIONAL_DISABLED") ||
    desc.includes("currency") ||
    desc.includes("not enabled") ||
    desc.includes("cross-border");

  if (isConfigOrEligibility) {
    facts.push("merchant_capability_or_currency_mismatch");

    return {
      category: "merchant_config",
      confidence: 0.94,
      facts_used: facts,
      explanation:
        "The merchant account is not enabled for international payments or the specified currency. Razorpay international enablement is required.",
      recommended_action: "escalate_support",
      do_not_do: [
        "tell_customer_it_is_their_fault",
        "retry_without_config_fix",
      ],
      stopping_rule: "Halt attempts until merchant international settings are verified.",
      needs_human_approval: true,
    };
  }

  // 6. Fallback: Unknown
  facts.push("ambiguous_or_missing_evidence");

  return {
    category: "unknown",
    confidence: 0.45,
    facts_used: facts,
    explanation:
      "Available payment evidence is incomplete or conflicting. The system cannot reliably determine if funds were deducted.",
    recommended_action: "escalate_support",
    do_not_do: [
      "guess_payment_state",
      "mark_order_paid",
      "issue_blind_refund",
    ],
    stopping_rule: "Await verified webhook event or inspect gateway logs directly.",
    needs_human_approval: true,
  };
}

/**
 * Helper to produce a diagnosis directly from database entities.
 */
export function diagnoseFromEntities(
  paymentCase: PaymentCase,
  attempt?: PaymentAttempt | null,
  order?: Order | null
): DiagnosisResult {
  return diagnosePaymentFailure({
    errorCode: attempt?.errorCode || null,
    errorDescription: attempt?.errorDescription || paymentCase.plainExplanation || null,
    currency: order?.currency || "USD",
    amount: order?.amount || 0,
    attemptStatus: attempt?.status || null,
    hasCaptureEvent: attempt?.status === "captured" || attempt?.status === "settled",
  });
}
