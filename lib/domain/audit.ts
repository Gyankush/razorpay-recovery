import { db } from "@/db";
import { auditLogs, type AuditLog, type NewAuditLog } from "@/db/schema";
import { eq, desc } from "drizzle-orm";

export interface LogAuditParams {
  actor: string;
  action: string;
  entity: string;
  entityId?: string | null;
  before?: any;
  after?: any;
  requestId?: string | null;
}

/**
 * Appends an immutable audit record to `audit_logs` for compliance,
 * transparency, and system forensics.
 */
export async function logAuditEvent(params: LogAuditParams): Promise<AuditLog> {
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
        requestId: params.requestId || `req_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      })
      .returning();

    console.log(`[Audit] ${params.actor} -> ${params.action} on ${params.entity}:${params.entityId || "N/A"}`);
    return log;
  } catch (error) {
    console.error("Failed to write audit log:", error);
    // Return placeholder so caller doesn't fail on audit log errors
    return {
      id: "error-log",
      actor: params.actor,
      action: params.action,
      entity: params.entity,
      entityId: params.entityId || null,
      beforeJson: null,
      afterJson: null,
      requestId: null,
      createdAt: new Date(),
    };
  }
}

/**
 * Retrieves audit entries ordered chronologically descending.
 */
export async function getAuditHistory(options?: {
  entity?: string;
  actor?: string;
  limit?: number;
}): Promise<AuditLog[]> {
  const limit = options?.limit || 50;

  if (options?.entity) {
    return db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entity, options.entity))
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit);
  }

  if (options?.actor) {
    return db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.actor, options.actor))
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit);
  }

  return db
    .select()
    .from(auditLogs)
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit);
}
