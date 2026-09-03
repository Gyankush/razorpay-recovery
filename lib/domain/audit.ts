import { db } from "@/db";
import { auditLogs, type AuditLog } from "@/db/schema";
import { eq, desc, and, gte, lte, type SQL } from "drizzle-orm";

export interface LogAuditParams {
  actor: string;
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  requestId?: string | null;
}

/**
 * Appends an immutable audit record to `audit_logs`.
 *
 * Returns the inserted row, or `null` when the write fails — callers MUST
 * treat `null` as "audit hole, alert" and never as success. (Previously this
 * returned a fake `{id:"error-log"}` row, which made compliance trails lie.)
 */
export async function logAuditEvent(
  params: LogAuditParams
): Promise<AuditLog | null> {
  try {
    const [log] = await db
      .insert(auditLogs)
      .values({
        actor: params.actor,
        action: params.action,
        entity: params.entity,
        entityId: params.entityId || null,
        beforeJson: params.before ? JSON.stringify(params.before) : null,
        afterJson: params.after ? JSON.stringify(params.after) : null,
        requestId: params.requestId || null,
      })
      .returning();

    console.log(
      `[Audit] ${params.actor} -> ${params.action} on ${params.entity}:${params.entityId || "N/A"}`
    );
    return log;
  } catch (error) {
    console.error("AUDIT HOLE — failed to write audit log:", error, {
      actor: params.actor,
      action: params.action,
      entity: params.entity,
      entityId: params.entityId,
    });
    return null;
  }
}

/**
 * Retrieves audit entries ordered chronologically descending.
 */
export async function getAuditHistory(options?: {
  entity?: string;
  actor?: string;
  limit?: number;
  since?: Date;
  until?: Date;
}): Promise<AuditLog[]> {
  const limit = Math.min(Math.max(options?.limit || 50, 1), 200);
  const conditions: SQL[] = [];
  if (options?.entity) conditions.push(eq(auditLogs.entity, options.entity));
  if (options?.actor) conditions.push(eq(auditLogs.actor, options.actor));
  if (options?.since) conditions.push(gte(auditLogs.createdAt, options.since));
  if (options?.until) conditions.push(lte(auditLogs.createdAt, options.until));

  if (conditions.length > 0) {
    return db
      .select()
      .from(auditLogs)
      .where(and(...conditions))
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit);
  }

  return db
    .select()
    .from(auditLogs)
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit);
}
