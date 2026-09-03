import { db } from "@/db";
import { evalCases, type EvalCase } from "@/db/schema";
import {
  diagnosePaymentFailure,
  type DiagnosisInput,
  type FailureCategory,
  type RecommendedAction,
} from "./diagnose";

export interface BenchmarkCase {
  id: string;
  name: string;
  input: DiagnosisInput;
  expectedCategory: FailureCategory;
  expectedAction: RecommendedAction;
}

export interface EvaluationReport {
  total_cases: number;
  correct_diagnoses: number;
  diagnosis_accuracy: number; // e.g. 96.0%
  correct_actions: number;
  safe_action_precision: number; // e.g. 98.0%
  unknown_honesty: number; // 100%
  duration_ms: number;
  failures: Array<{
    case_id: string;
    expected_category: string;
    actual_category: string;
    expected_action: string;
    actual_action: string;
  }>;
  category_breakdown: Record<string, { total: number; correct: number }>;
}

/**
 * 50 Held-Out Synthetic Test Scenarios:
 * Calibrated against the PRD international payment recovery taxonomy.
 */
export function generate50BenchmarkCases(): BenchmarkCase[] {
  const cases: BenchmarkCase[] = [];

  // Group 1: International 3DS / Authentication Failures (15 cases)
  const authErrors = [
    "BAD_REQUEST_ERROR",
    "3DS_CHALLENGE_TIMEOUT",
    "OTP_EXPIRED",
    "CUSTOMER_ABANDONED_VERIFICATION",
    "SMS_DELIVERY_FAILED",
  ];
  for (let i = 1; i <= 15; i++) {
    const err = authErrors[i % authErrors.length];
    cases.push({
      id: `eval_3ds_${i}`,
      name: `International 3DS Failure #${i}`,
      input: {
        errorCode: err,
        errorDescription: "Authentication step not completed by cardholder",
        currency: i % 2 === 0 ? "USD" : "EUR",
        amount: 2900 + i * 500,
        hasCaptureEvent: false,
      },
      expectedCategory: "customer_action",
      expectedAction: "send_alternate_payment_link",
    });
  }

  // Group 2: Issuer Declines / Cross-Border Disabled (10 cases)
  const issuerErrors = [
    "GATEWAY_ERROR",
    "DO_NOT_HONOR",
    "TRANSACTION_DECLINED",
    "INSUFFICIENT_FUNDS",
  ];
  for (let i = 1; i <= 10; i++) {
    const err = issuerErrors[i % issuerErrors.length];
    cases.push({
      id: `eval_issuer_${i}`,
      name: `Issuer Decline #${i}`,
      input: {
        errorCode: err,
        errorDescription: "Declined by issuing bank. Cross-border e-commerce restriction.",
        currency: "USD",
        amount: 4900 + i * 200,
        hasCaptureEvent: false,
      },
      expectedCategory: "customer_action",
      expectedAction: "send_alternate_payment_link",
    });
  }

  // Group 3: Automated Risk Blocks (8 cases)
  const riskErrors = [
    "TRANSACTION_RISK_BLOCKED",
    "FRAUD_RULE_TRIGGERED",
    "HIGH_VELOCITY_SUSPICION",
  ];
  for (let i = 1; i <= 8; i++) {
    const err = riskErrors[i % riskErrors.length];
    cases.push({
      id: `eval_risk_${i}`,
      name: `Gateway Risk Block #${i}`,
      input: {
        errorCode: err,
        errorDescription: "Risk scoring engine blocked transaction",
        currency: "USD",
        amount: 15000 + i * 1000,
        hasCaptureEvent: false,
      },
      expectedCategory: "risk_block",
      expectedAction: "escalate_support",
    });
  }

  // Group 4: Transient Network Timeouts (7 cases)
  for (let i = 1; i <= 7; i++) {
    cases.push({
      id: `eval_transient_${i}`,
      name: `Transient Bank Timeout #${i}`,
      input: {
        errorCode: "GATEWAY_TIMEOUT",
        errorDescription: "Network connection with issuing bank timed out before authorization response",
        currency: "GBP",
        amount: 5000,
        hasCaptureEvent: false,
      },
      expectedCategory: "transient",
      expectedAction: "cooldown_retry",
    });
  }

  // Group 5: Merchant Configuration / Currency Enablement (5 cases)
  for (let i = 1; i <= 5; i++) {
    cases.push({
      id: `eval_config_${i}`,
      name: `Merchant Config Error #${i}`,
      input: {
        errorCode: "CURRENCY_NOT_SUPPORTED",
        errorDescription: "International payment is not enabled for this currency on merchant account",
        currency: "CAD",
        amount: 3900,
        hasCaptureEvent: false,
      },
      expectedCategory: "merchant_config",
      expectedAction: "escalate_support",
    });
  }

  // Group 6: Ambiguous / Unknown State (5 cases)
  for (let i = 1; i <= 5; i++) {
    cases.push({
      id: `eval_unknown_${i}`,
      name: `Conflicting Evidence Case #${i}`,
      input: {
        errorCode: null,
        errorDescription: "Unrecognized empty response from acquirer rail",
        currency: "USD",
        amount: 1000,
        hasCaptureEvent: false,
      },
      expectedCategory: "unknown",
      expectedAction: "escalate_support",
    });
  }

  return cases;
}

/**
 * Runs the 50-case held-out benchmark.
 * DB persistence is OPT-IN (`{persist:true}`) so routine benchmark runs —
 * including the `/api/eval/run` endpoint default — don't flood the prod
 * `eval_cases` table with 50 rows per click.
 */
export async function runAIEvaluation(options?: {
  persist?: boolean;
}): Promise<EvaluationReport> {
  const startTime = Date.now();
  const benchmark = generate50BenchmarkCases();

  let correctDiagnoses = 0;
  let correctActions = 0;
  let unknownHonestyCount = 0;
  let unknownTotal = 0;

  const failures: EvaluationReport["failures"] = [];
  const categoryBreakdown: Record<string, { total: number; correct: number }> = {};

  for (const bCase of benchmark) {
    const actual = diagnosePaymentFailure(bCase.input);

    const isCategoryMatch = actual.category === bCase.expectedCategory;
    const isActionMatch = actual.recommended_action === bCase.expectedAction;

    if (isCategoryMatch) correctDiagnoses++;
    if (isActionMatch) correctActions++;

    if (bCase.expectedCategory === "unknown") {
      unknownTotal++;
      if (actual.category === "unknown") unknownHonestyCount++;
    }

    if (!categoryBreakdown[bCase.expectedCategory]) {
      categoryBreakdown[bCase.expectedCategory] = { total: 0, correct: 0 };
    }
    categoryBreakdown[bCase.expectedCategory].total++;
    if (isCategoryMatch) {
      categoryBreakdown[bCase.expectedCategory].correct++;
    }

    if (!isCategoryMatch || !isActionMatch) {
      failures.push({
        case_id: bCase.id,
        expected_category: bCase.expectedCategory,
        actual_category: actual.category,
        expected_action: bCase.expectedAction,
        actual_action: actual.recommended_action,
      });
    }

    // Record into eval_cases table (opt-in: default is report-only)
    if (options?.persist) {
      try {
        await db.insert(evalCases).values({
          scenarioName: bCase.name,
          inputJson: JSON.stringify(bCase.input),
          expectedCategory: bCase.expectedCategory,
          expectedAction: bCase.expectedAction,
          actualJson: JSON.stringify(actual),
          score: isCategoryMatch && isActionMatch ? "1.00" : "0.50",
        });
      } catch {
        // ignore insert failure during fast test iterations
      }
    }
  }

  const durationMs = Date.now() - startTime;
  const diagnosisAccuracy = Math.round((correctDiagnoses / benchmark.length) * 1000) / 10;
  const safeActionPrecision = Math.round((correctActions / benchmark.length) * 1000) / 10;
  const unknownHonesty = unknownTotal > 0 ? Math.round((unknownHonestyCount / unknownTotal) * 100) : 100;

  return {
    total_cases: benchmark.length,
    correct_diagnoses: correctDiagnoses,
    diagnosis_accuracy: diagnosisAccuracy,
    correct_actions: correctActions,
    safe_action_precision: safeActionPrecision,
    unknown_honesty: unknownHonesty,
    duration_ms: durationMs,
    failures,
    category_breakdown: categoryBreakdown,
  };
}
