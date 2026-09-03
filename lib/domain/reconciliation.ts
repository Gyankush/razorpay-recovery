import { db } from "@/db";
import {
  settlements,
  reconItems,
  paymentAttempts,
  type ReconItem,
} from "@/db/schema";
import { eq, desc, and, sql } from "drizzle-orm";
import { logAuditEvent } from "./audit";

export interface ReconSummary {
  total_processed: number;
  matched_count: number;
  discrepancy_count: number;
  pending_count: number;
  total_difference: number;
  exceptions: ReconItem[];
}

/** Upserts one recon item keyed by (sourceType, sourceId); returns true when newly inserted. */
async function upsertReconItem(values: {
  sourceType: string;
  sourceId: string;
  expected: number;
  actual: number;
  difference: number;
  status: "matched" | "discrepancy" | "pending";
  explanation: string;
}): Promise<boolean> {
  const inserted = await db
    .insert(reconItems)
    .values(values)
    .onConflictDoNothing({
      target: [reconItems.sourceType, reconItems.sourceId],
    })
    .returning({ id: reconItems.id });

  if (inserted.length > 0) return true;

  await db
    .update(reconItems)
    .set({
      expected: values.expected,
      actual: values.actual,
      difference: values.difference,
      status: values.status,
      explanation: values.explanation,
    })
    .where(
      and(
        eq(reconItems.sourceType, values.sourceType),
        eq(reconItems.sourceId, values.sourceId)
      )
    );
  return false;
}

/**
 * Executes deterministic financial reconciliation:
 * 1. Matches captured payment attempts with gateway settlement records.
 * 2. Verifies gross amounts, MDR fees, and GST tax deductions.
 * 3. Detects shortfalls, currency markups, and un-settled transactions.
 * 4. Records explainable reconciliation items and audit events.
 *
 * Counts are read back from the database after upserts, so repeated runs
 * report stable numbers instead of flapping `pending_count`.
 */
export async function runReconciliationEngine(): Promise<ReconSummary> {
  const allSettlements = await db.select().from(settlements);
  const allAttempts = await db.select().from(paymentAttempts);

  for (const set of allSettlements) {
    const expectedNet = set.gross - set.fee - set.tax;
    const diff = set.net - expectedNet;

    let status: "matched" | "discrepancy" = "matched";
    let explanation =
      "Financial settlement matched perfectly (Gross - Fee - Tax = Net).";

    if (diff !== 0) {
      status = "discrepancy";
      explanation = `Settlement shortfall of ${(Math.abs(diff) / 100).toFixed(
        2
      )} ${set.currency}. Expected net ${(expectedNet / 100).toFixed(
        2
      )}, actual credited ${(set.net / 100).toFixed(
        2
      )}. Likely cross-border currency conversion fee (FX markup) or withheld reserve.`;
    }

    const isNew = await upsertReconItem({
      sourceType: "settlement",
      sourceId: set.providerSettlementId,
      expected: expectedNet,
      actual: set.net,
      difference: diff,
      status,
      explanation,
    });

    if (isNew) {
      await logAuditEvent({
        actor: "reconciliation_engine",
        action: status === "matched" ? "recon_matched" : "recon_discrepancy_flagged",
        entity: "recon_item",
        entityId: set.providerSettlementId,
        after: { expected: expectedNet, actual: set.net, diff, explanation },
      });
    }
  }

  // Check for captured payments with no settlement (pending reconciliation)
  const settledPaymentIds = new Set(allSettlements.map((s) => s.paymentId));
  for (const att of allAttempts) {
    if (
      att.status === "captured" &&
      att.providerPaymentId &&
      !settledPaymentIds.has(att.providerPaymentId)
    ) {
      const isNew = await upsertReconItem({
        sourceType: "payment",
        sourceId: att.providerPaymentId,
        expected: 1, // at least 1 settlement expected
        actual: 0,
        difference: 1,
        status: "pending",
        explanation: `Payment ${att.providerPaymentId} was captured but has no settlement record in gateway ledger. Expected within T+2 settlement cycle.`,
      });
      if (isNew) {
        await logAuditEvent({
          actor: "reconciliation_engine",
          action: "recon_pending_flagged",
          entity: "recon_item",
          entityId: att.providerPaymentId,
          after: { paymentId: att.providerPaymentId },
        });
      }
    }
  }

  // Stable counts straight from the ledger
  const counts = await db
    .select({
      status: reconItems.status,
      count: sql<number>`count(*)`,
      totalDiff: sql<number>`coalesce(sum(abs(${reconItems.difference})), 0)`,
    })
    .from(reconItems)
    .groupBy(reconItems.status);

  let matched = 0;
  let discrepancy = 0;
  let pending = 0;
  let reconDiscrepancyAbs = 0;
  for (const row of counts) {
    const n = Number(row.count);
    if (row.status === "matched") matched = n;
    else if (row.status === "discrepancy") {
      discrepancy = n;
      reconDiscrepancyAbs = Number(row.totalDiff);
    } else if (row.status === "pending") pending = n;
  }

  // Settlement shortfall totals (kept comparable with previous reports)
  let settlementShortfall = 0;
  for (const set of allSettlements) {
    const diff = set.net - (set.gross - set.fee - set.tax);
    if (diff !== 0) settlementShortfall += Math.abs(diff);
  }

  const exceptions = await db
    .select()
    .from(reconItems)
    .where(eq(reconItems.status, "discrepancy"))
    .orderBy(desc(reconItems.createdAt));

  return {
    total_processed: allSettlements.length,
    matched_count: matched,
    discrepancy_count: discrepancy,
    pending_count: pending,
    total_difference: settlementShortfall || reconDiscrepancyAbs,
    exceptions,
  };
}

/**
 * Returns all reconciliation items (exceptions & matched).
 */
export async function getReconciliationExceptions(statusFilter?: "discrepancy" | "pending" | "matched") {
  if (statusFilter) {
    return db
      .select()
      .from(reconItems)
      .where(eq(reconItems.status, statusFilter))
      .orderBy(desc(reconItems.createdAt));
  }

  return db
    .select()
    .from(reconItems)
    .orderBy(desc(reconItems.createdAt));
}
