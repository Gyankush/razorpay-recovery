import { db } from "@/db";
import {
  autopilotPolicies,
  merchants,
  orders,
  paymentAttempts,
  paymentCases,
  paymentLinks,
  recoveryActions,
  type AutopilotPolicy,
} from "@/db/schema";
import { eq, and, desc, gte, lte, lt, sql } from "drizzle-orm";
import { createRecoveryPaymentLink } from "@/lib/connectors/razorpay";
import { runReconciliationEngine } from "@/lib/domain/reconciliation";
import { sweepStaleWebhooks } from "@/lib/domain/webhook-sweeper";
import { logAuditEvent } from "@/lib/domain/audit";
import { safeJsonParse } from "@/lib/http";

/**
 * Autonomous recovery agent ("Autopilot").
 *
 * Every run the agent:
 *  1. loads each merchant's ENABLED autopilot policy (disabled by default),
 *  2. sweeps that merchant's open cases oldest-first,
 *  3. auto-executes ONLY allowlisted, under-cap, high-confidence,
 *     link-recoverable cases — risk/unknown/config cases always stay human,
 *  4. auto-resolves cases whose order actually got paid late (no link sent),
 *  5. runs the reconciliation sweep and files a run report in the audit log.
 *
 * Hard rules (not configurable): NEVER_AUTO categories are never executed,
 * amounts above the policy cap are never executed, and every decision —
 * execute AND skip — is auditable.
 */

export const NEVER_AUTO = new Set(["risk_block", "merchant_config", "unknown"]);
export const LINK_ACTION = "send_alternate_payment_link";

export interface PolicyUpdate {
  enabled?: boolean;
  allowed_categories?: string[];
  max_auto_amount?: number;
  max_actions_per_run?: number;
  min_confidence?: number;
}

export function sanitizePolicyUpdate(input: PolicyUpdate): {
  ok: boolean;
  error?: string;
  value?: {
    enabled: boolean;
    allowedCategories: string[];
    maxAutoAmount: number;
    maxActionsPerRun: number;
    minConfidence: string;
  };
} {
  const allowed = Array.isArray(input.allowed_categories)
    ? input.allowed_categories.filter(
        (c): c is string => typeof c === "string" && !NEVER_AUTO.has(c)
      )
    : ["customer_action", "transient"];
  if (allowed.length === 0) {
    return { ok: false, error: "allowed_categories must include at least one auto-safe category" };
  }
  const maxAuto = Math.floor(Number(input.max_auto_amount ?? 10000));
  if (!Number.isFinite(maxAuto) || maxAuto < 100 || maxAuto > 100_000_00) {
    return { ok: false, error: "max_auto_amount must be between 100 and 10000000 (minor units)" };
  }
  const maxRun = Math.floor(Number(input.max_actions_per_run ?? 10));
  if (!Number.isFinite(maxRun) || maxRun < 1 || maxRun > 50) {
    return { ok: false, error: "max_actions_per_run must be between 1 and 50" };
  }
  const conf = Number(input.min_confidence ?? 0.7);
  if (!Number.isFinite(conf) || conf < 0.5 || conf > 1) {
    return { ok: false, error: "min_confidence must be between 0.50 and 1.00" };
  }
  return {
    ok: true,
    value: {
      enabled: input.enabled === true,
      allowedCategories: allowed,
      maxAutoAmount: maxAuto,
      maxActionsPerRun: maxRun,
      minConfidence: conf.toFixed(2),
    },
  };
}

export async function ensurePolicy(merchantId: string): Promise<AutopilotPolicy> {
  const [existing] = await db
    .select()
    .from(autopilotPolicies)
    .where(eq(autopilotPolicies.merchantId, merchantId))
    .limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(autopilotPolicies)
    .values({ merchantId, enabled: false })
    .onConflictDoNothing({ target: autopilotPolicies.merchantId })
    .returning();
  return (
    created ??
    (
      await db
        .select()
        .from(autopilotPolicies)
        .where(eq(autopilotPolicies.merchantId, merchantId))
        .limit(1)
    )[0]
  );
}

export async function listMerchantsWithPolicies() {
  const all = await db.select().from(merchants).orderBy(desc(merchants.createdAt)).limit(50);
  const out = [];
  for (const m of all) {
    out.push({ merchant: m, policy: await ensurePolicy(m.id) });
  }
  return out;
}

export interface AgentSkip {
  case_id: string;
  order_ref: string;
  reason: string;
}

export interface AgentRunReport {
  run_id: string;
  started_at: string;
  merchants_processed: number;
  candidates: number;
  auto_executed: number;
  auto_resolved_late_capture: number;
  failed: number;
  skipped: AgentSkip[];
  links_expired: number;
  sweep: { swept: number; processed: number; failed: number } | null;
  recon: {
    matched: number;
    discrepancy: number;
    pending: number;
  } | null;
}

export async function runAutopilot(): Promise<AgentRunReport> {
  const runId = `auto_${Date.now().toString(36)}`;
  const startedAt = new Date().toISOString();
  const day = startedAt.slice(0, 10);

  const report: AgentRunReport = {
    run_id: runId,
    started_at: startedAt,
    merchants_processed: 0,
    candidates: 0,
    auto_executed: 0,
    auto_resolved_late_capture: 0,
    failed: 0,
    skipped: [],
    links_expired: 0,
    sweep: null,
    recon: null,
  };

  const enabledPolicies = await db
    .select()
    .from(autopilotPolicies)
    .where(eq(autopilotPolicies.enabled, true));

  for (const policy of enabledPolicies) {
    const allowed = new Set(
      (safeJsonParse<string[]>(policy.allowedCategories) ?? []).filter(
        (c) => !NEVER_AUTO.has(c)
      )
    );
    const minConf = Number(policy.minConfidence ?? 0.7);

    const candidates = await db
      .select({
        caseId: paymentCases.id,
        failureCategory: paymentCases.failureCategory,
        confidence: paymentCases.confidence,
        recommendedAction: paymentCases.recommendedAction,
        orderId: orders.id,
        amount: orders.amount,
        currency: orders.currency,
        externalOrderId: orders.externalOrderId,
      })
      .from(paymentCases)
      .innerJoin(orders, eq(paymentCases.orderId, orders.id))
      .where(
        and(
          eq(paymentCases.status, "open"),
          eq(orders.merchantId, policy.merchantId)
        )
      )
      .orderBy(desc(paymentCases.createdAt))
      .limit(policy.maxActionsPerRun * 3);
    // NOTE: newest-first — fresh failures recover at far higher rates than
    // stale ones, so the agent always works today's recoverable revenue
    // before aging backlog.

    report.merchants_processed += 1;
    let executedThisMerchant = 0;

    for (const item of candidates) {
      if (executedThisMerchant >= policy.maxActionsPerRun) break;
      report.candidates += 1;
      const skip = (reason: string) =>
        report.skipped.push({
          case_id: item.caseId,
          order_ref: item.externalOrderId,
          reason,
        });

      // Late-capture hygiene FIRST: never send a recovery link for a paid order.
      const attempts = await db
        .select()
        .from(paymentAttempts)
        .where(eq(paymentAttempts.orderId, item.orderId))
        .limit(20);
      if (attempts.some((a) => a.status === "captured" || a.status === "settled")) {
        await db
          .update(paymentCases)
          .set({
            status: "resolved",
            plainExplanation:
              "Autopilot: order shows a captured/settled attempt — no recovery link needed.",
          })
          .where(eq(paymentCases.id, item.caseId));
        await logAuditEvent({
          actor: "autopilot",
          action: "case_auto_resolved_late_capture",
          entity: "payment_case",
          entityId: item.caseId,
          requestId: runId,
        });
        report.auto_resolved_late_capture += 1;
        continue;
      }

      if (item.recommendedAction !== LINK_ACTION) {
        skip("not_link_recoverable");
        continue;
      }
      if (!item.failureCategory || NEVER_AUTO.has(item.failureCategory) || !allowed.has(item.failureCategory)) {
        skip("category_not_allowlisted");
        continue;
      }
      if (item.amount > policy.maxAutoAmount) {
        skip("above_amount_cap");
        continue;
      }
      if (Number(item.confidence ?? 0) < minConf) {
        skip("low_confidence_needs_human");
        continue;
      }

      try {
        const res = await createRecoveryPaymentLink(
          item.caseId,
          item.amount,
          item.currency,
          `auto_${day}_${item.caseId}`,
          "autopilot"
        );
        if (res.success) {
          executedThisMerchant += 1;
          report.auto_executed += 1;
          await logAuditEvent({
            actor: "autopilot",
            action: "case_auto_recovered",
            entity: "recovery_action",
            entityId: res.action.id,
            after: { case_id: item.caseId, url: res.payment_link_url },
            requestId: runId,
          });
        } else {
          report.failed += 1;
          skip(`link_failed:${res.error ?? "sdk_error"}`.slice(0, 120));
        }
      } catch (err: any) {
        report.failed += 1;
        skip(`exception:${String(err?.message ?? err).slice(0, 80)}`);
      }
    }

    await logAuditEvent({
      actor: "autopilot",
      action: "merchant_sweep_completed",
      entity: "merchant",
      entityId: policy.merchantId,
      after: {
        run_id: runId,
        executed: executedThisMerchant,
        skipped: report.skipped.length,
      },
      requestId: runId,
    });
  }

  // Reconciliation sweep (best-effort; never fails the agent run)
  try {
    const recon = await runReconciliationEngine();
    report.recon = {
      matched: recon.matched_count,
      discrepancy: recon.discrepancy_count,
      pending: recon.pending_count,
    };
  } catch (err) {
    console.error("[Autopilot] recon sweep failed:", err);
  }

  // Expiry sweeper: created links past their 60-min window become `expired`
  // so operators and the support packet never present dead checkouts.
  try {
    const expired = await db
      .update(paymentLinks)
      .set({ status: "expired" })
      .where(
        and(
          eq(paymentLinks.status, "created"),
          lt(paymentLinks.expiry, new Date())
        )
      )
      .returning({ id: paymentLinks.id });
    report.links_expired = expired.length;
  } catch (err) {
    console.error("[Autopilot] link expiry sweep failed:", err);
  }

  // Missed-webhook replay (best-effort; replays converge idempotently).
  try {
    report.sweep = await sweepStaleWebhooks(5, 25);
  } catch (err) {
    console.error("[Autopilot] webhook sweep failed:", err);
  }

  await logAuditEvent({
    actor: "autopilot",
    action: "agent_run_completed",
    entity: "agent_run",
    entityId: runId,
    after: report,
    requestId: runId,
  });

  return report;
}

export interface AutopilotBrief {
  generated_at: string;
  last_24h: {
    new_cases: number;
    resolved: number;
    auto_recovered: number;
    open_now: number;
  };
  recovery_rate_7d_pct: number;
  top_category_7d: string | null;
  open_by_category: Array<{ category: string; count: number }>;
  anomalies: Array<{ severity: "info" | "warn"; message: string }>;
}

export async function getAutopilotBrief(): Promise<AutopilotBrief> {
  const now = Date.now();
  const d1 = new Date(now - 24 * 3600 * 1000);
  const d7 = new Date(now - 7 * 24 * 3600 * 1000);
  const d8 = new Date(now - 8 * 24 * 3600 * 1000);

  const countSince = async (from: Date) =>
    Number(
      (
        await db
          .select({ n: sql<number>`count(*)` })
          .from(paymentCases)
          .where(gte(paymentCases.createdAt, from))
      )[0].n
    );

  const new24 = await countSince(d1);
  const newPrior7 = await db
    .select({ n: sql<number>`count(*)` })
    .from(paymentCases)
    .where(
      and(gte(paymentCases.createdAt, d8), lte(paymentCases.createdAt, d1))
    )
    .then((r) => Number(r[0].n));

  const auto24 = await db
    .select({ n: sql<number>`count(*)` })
    .from(recoveryActions)
    .where(
      and(
        eq(recoveryActions.status, "executed"),
        eq(recoveryActions.approvedBy, "autopilot"),
        gte(recoveryActions.executedAt, d1)
      )
    )
    .then((r) => Number(r[0].n));

  const openNow = Number(
    (
      await db
        .select({ n: sql<number>`count(*)` })
        .from(paymentCases)
        .where(eq(paymentCases.status, "open"))
    )[0].n
  );

  const total7 = await countSince(d7);
  const resolvedCases7 = await db
    .select({ n: sql<number>`count(*)` })
    .from(paymentCases)
    .where(
      and(
        eq(paymentCases.status, "resolved"),
        gte(paymentCases.createdAt, d7)
      )
    )
    .then((r) => Number(r[0].n));

  const topCat = await db
    .select({
      category: paymentCases.failureCategory,
      n: sql<number>`count(*)`,
    })
    .from(paymentCases)
    .where(gte(paymentCases.createdAt, d7))
    .groupBy(paymentCases.failureCategory)
    .orderBy(sql`count(*) desc`)
    .limit(1);

  const openByCat = await db
    .select({
      category: paymentCases.failureCategory,
      n: sql<number>`count(*)`,
    })
    .from(paymentCases)
    .where(eq(paymentCases.status, "open"))
    .groupBy(paymentCases.failureCategory);

  const new24ByCat = await db
    .select({
      category: paymentCases.failureCategory,
      n: sql<number>`count(*)`,
    })
    .from(paymentCases)
    .where(gte(paymentCases.createdAt, d1))
    .groupBy(paymentCases.failureCategory);

  const anomalies: AutopilotBrief["anomalies"] = [];
  const avgDaily = newPrior7 / 7;
  if (avgDaily >= 3 && new24 > 2 * avgDaily) {
    anomalies.push({
      severity: "warn",
      message: `Failure spike: ${new24} new cases in 24h vs ${avgDaily.toFixed(1)}/day average. Check gateway status before widening autopilot.`,
    });
  }
  const riskNew = new24ByCat.find((r) => r.category === "risk_block");
  if (new24 >= 5 && riskNew && Number(riskNew.n) / new24 > 0.3) {
    anomalies.push({
      severity: "warn",
      message: `Elevated risk blocks: ${riskNew.n}/${new24} new cases flagged. Autopilot correctly refuses these — route to manual review.`,
    });
  }
  if (openNow > 20 && openNow > resolvedCases7) {
    anomalies.push({
      severity: "info",
      message: `Backlog watch: ${openNow} open cases vs ${resolvedCases7} resolved in 7d. Consider raising autopilot caps for safe categories.`,
    });
  }

  return {
    generated_at: new Date().toISOString(),
    last_24h: {
      new_cases: new24,
      resolved: Number(
        (
          await db
            .select({ n: sql<number>`count(*)` })
            .from(paymentCases)
            .where(
              and(
                eq(paymentCases.status, "resolved"),
                gte(paymentCases.createdAt, d1)
              )
            )
        )[0].n
      ),
      auto_recovered: auto24,
      open_now: openNow,
    },
    recovery_rate_7d_pct:
      total7 > 0 ? Math.round((resolvedCases7 / total7) * 1000) / 10 : 0,
    top_category_7d: topCat[0]?.category ?? null,
    open_by_category: openByCat.map((r) => ({
      category: r.category ?? "unknown",
      count: Number(r.n),
    })),
    anomalies,
  };
}
