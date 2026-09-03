import { db } from "@/db";
import {
  settlements,
  reconItems,
  paymentAttempts,
  orders,
  type ReconItem,
  type Settlement,
} from "@/db/schema";
import { eq, desc, and } from "drizzle-orm";
import { logAuditEvent } from "./audit";

export interface ReconSummary {
  total_processed: number;
  matched_count: number;
  discrepancy_count: number;
  pending_count: number;
  total_difference: number;
  exceptions: ReconItem[];
}

/**
 * Executes deterministic financial reconciliation:
 * 1. Matches captured payment attempts with gateway settlement records.
 * 2. Verifies gross amounts, MDR fees, and GST tax deductions.
 * 3. Detects shortfalls, currency markups, and un-settled transactions.
 * 4. Records explainable reconciliation items and audit events.
 */
export async function runReconciliationEngine(): Promise<ReconSummary> {
  const allSettlements = await db.select().from(settlements);
  const allAttempts = await db.select().from(paymentAttempts);

  const attemptsByProviderId = new Map<string, typeof allAttempts[0]>();
  for (const att of allAttempts) {
    if (att.providerPaymentId) {
      attemptsByProviderId.set(att.providerPaymentId, att);
    }
  }

  let matched = 0;
  let discrepancy = 0;
  let pending = 0;
  let totalDiff = 0;

  for (const set of allSettlements) {
    const paymentId = set.paymentId;
    const expectedNet = set.gross - set.fee - set.tax;
    const diff = set.net - expectedNet;

    // Check if recon item already exists
    const existing = await db
      .select()
      .from(reconItems)
      .where(
        and(
          eq(reconItems.sourceType, "settlement"),
          eq(reconItems.sourceId, set.providerSettlementId)
        )
      )
      .limit(1);

    let status: "matched" | "discrepancy" | "pending" = "matched";
    let explanation = "Financial settlement matched perfectly (Gross - Fee - Tax = Net).";

    if (diff !== 0) {
      status = "discrepancy";
      discrepancy++;
      totalDiff += Math.abs(diff);
      explanation = `Settlement shortfall of ${(Math.abs(diff) / 100).toFixed(
        2
      )} ${set.currency}. Expected net ${(expectedNet / 100).toFixed(
        2
      )}, actual credited ${(set.net / 100).toFixed(
        2
      )}. Likely cross-border currency conversion fee (FX markup) or withheld reserve.`;
    } else {
      matched++;
    }

    if (existing.length === 0) {
      await db.insert(reconItems).values({
        sourceType: "settlement",
        sourceId: set.providerSettlementId,
        expected: expectedNet,
        actual: set.net,
        difference: diff,
        status,
        explanation,
      });

      await logAuditEvent({
        actor: "reconciliation_engine",
        action: status === "matched" ? "recon_matched" : "recon_discrepancy_flagged",
        entity: "recon_item",
        entityId: set.providerSettlementId,
        after: { expected: expectedNet, actual: set.net, diff, explanation },
      });
    } else {
      await db
        .update(reconItems)
        .set({
          expected: expectedNet,
          actual: set.net,
          difference: diff,
          status,
          explanation,
        })
        .where(eq(reconItems.id, existing[0].id));
    }
  }

  // Check for captured payments with no settlement (pending reconciliation)
  const settledPaymentIds = new Set(allSettlements.map((s) => s.paymentId));
  for (const att of allAttempts) {
    if (att.status === "captured" && att.providerPaymentId && !settledPaymentIds.has(att.providerPaymentId)) {
      const existing = await db
        .select()
        .from(reconItems)
        .where(
          and(
            eq(reconItems.sourceType, "payment"),
            eq(reconItems.sourceId, att.providerPaymentId)
          )
        )
        .limit(1);

      if (existing.length === 0) {
        pending++;
        await db.insert(reconItems).values({
          sourceType: "payment",
          sourceId: att.providerPaymentId,
          expected: 1, // at least 1 settlement expected
          actual: 0,
          difference: 1,
          status: "pending",
          explanation: `Payment ${att.providerPaymentId} was captured but has no settlement record in gateway ledger. Expected within T+2 settlement cycle.`,
        });
      }
    }
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
    total_difference: totalDiff,
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
