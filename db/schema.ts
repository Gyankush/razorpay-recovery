import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  numeric,
  boolean,
  timestamp,
  pgEnum,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// -----------------------------------------------------------------------------
// Enums
// -----------------------------------------------------------------------------
export const merchantModeEnum = pgEnum("merchant_mode", ["test", "live"]);

export const paymentAttemptStatusEnum = pgEnum("payment_attempt_status", [
  "initiated",
  "authorized",
  "captured",
  "failed",
  "refunded",
  "settled",
  "unknown",
]);

export const paymentCaseStatusEnum = pgEnum("payment_case_status", [
  "open",
  "resolved",
  "action_required",
]);

export const recoveryActionStatusEnum = pgEnum("recovery_action_status", [
  "proposed",
  "approved",
  "rejected",
  "executed",
]);

export const reconItemStatusEnum = pgEnum("recon_item_status", [
  "matched",
  "discrepancy",
  "pending",
  "resolved",
]);

// -----------------------------------------------------------------------------
// Tables
// -----------------------------------------------------------------------------

/**
 * Merchants table: Stores merchant identity, configuration mode, and connector settings.
 */
export const merchants = pgTable("merchants", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  mode: merchantModeEnum("mode").default("test").notNull(),
  encryptedKeyRef: text("encrypted_key_ref"),
  timezone: varchar("timezone", { length: 50 }).default("Asia/Kolkata"),
  policyId: varchar("policy_id", { length: 50 }).default("default_v1"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Customers table: Minimum customer metadata to group international attempts without PCI scope.
 */
export const customers = pgTable("customers", {
  id: uuid("id").defaultRandom().primaryKey(),
  merchantId: uuid("merchant_id")
    .references(() => merchants.id, { onDelete: "cascade" })
    .notNull(),
  emailHash: varchar("email_hash", { length: 255 }),
  country: varchar("country", { length: 10 }).default("US"),
  currency: varchar("currency", { length: 10 }).default("USD"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Orders table: Stores business order details (can have multiple payment attempts).
 */
export const orders = pgTable("orders", {
  id: uuid("id").defaultRandom().primaryKey(),
  merchantId: uuid("merchant_id")
    .references(() => merchants.id, { onDelete: "cascade" })
    .notNull(),
  externalOrderId: varchar("external_order_id", { length: 255 }).notNull(),
  amount: integer("amount").notNull(), // amount in lowest currency unit (cents / paise)
  currency: varchar("currency", { length: 10 }).notNull(),
  status: varchar("status", { length: 50 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Payment Attempts table: Tracks every payment attempt per order with gateway references and status.
 */
export const paymentAttempts = pgTable("payment_attempts", {
  id: uuid("id").defaultRandom().primaryKey(),
  orderId: uuid("order_id")
    .references(() => orders.id, { onDelete: "cascade" })
    .notNull(),
  providerPaymentId: varchar("provider_payment_id", { length: 255 }),
  method: varchar("method", { length: 50 }).default("card"),
  country: varchar("country", { length: 10 }).default("US"),
  status: paymentAttemptStatusEnum("status").notNull(),
  errorCode: varchar("error_code", { length: 100 }),
  errorDescription: text("error_description"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Webhook Events table: Replayable and auditable source of truth for incoming gateway webhooks.
 */
export const webhookEvents = pgTable("webhook_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  providerEventId: varchar("provider_event_id", { length: 255 }).unique().notNull(),
  eventType: varchar("event_type", { length: 100 }).notNull(),
  rawBody: text("raw_body").notNull(),
  signatureValid: boolean("signature_valid").default(false).notNull(),
  processed: boolean("processed").default(false).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Payment Cases table: Work items opened when an order failure or ambiguity requires diagnosis & resolution.
 */
export const paymentCases = pgTable("payment_cases", {
  id: uuid("id").defaultRandom().primaryKey(),
  orderId: uuid("order_id")
    .references(() => orders.id, { onDelete: "cascade" })
    .notNull(),
  status: paymentCaseStatusEnum("status").default("open").notNull(),
  failureCategory: varchar("failure_category", { length: 100 }),
  confidence: numeric("confidence", { precision: 5, scale: 2 }),
  plainExplanation: text("plain_explanation"),
  recommendedAction: text("recommended_action"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Diagnoses table: Versioned explanations and observed facts for a payment case.
 */
export const diagnoses = pgTable("diagnoses", {
  id: uuid("id").defaultRandom().primaryKey(),
  caseId: uuid("case_id")
    .references(() => paymentCases.id, { onDelete: "cascade" })
    .notNull(),
  category: varchar("category", { length: 100 }).notNull(),
  factsJson: text("facts_json").notNull(), // JSON stringified array of facts
  explanation: text("explanation").notNull(),
  model: varchar("model", { length: 100 }).default("rule-engine-v1"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Recovery Actions table: Bounded recovery steps (proposed, approved, rejected, executed) with idempotency.
 */
export const recoveryActions = pgTable("recovery_actions", {
  id: uuid("id").defaultRandom().primaryKey(),
  caseId: uuid("case_id")
    .references(() => paymentCases.id, { onDelete: "cascade" })
    .notNull(),
  actionType: varchar("action_type", { length: 100 }).notNull(),
  status: recoveryActionStatusEnum("status").default("proposed").notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 255 }).unique().notNull(),
  approvedBy: varchar("approved_by", { length: 255 }),
  executedAt: timestamp("executed_at", { withTimezone: true }),
  resultJson: text("result_json"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Payment Links table: Fallback recovery links and their lifecycles.
 */
export const paymentLinks = pgTable("payment_links", {
  id: uuid("id").defaultRandom().primaryKey(),
  caseId: uuid("case_id")
    .references(() => paymentCases.id, { onDelete: "cascade" })
    .notNull(),
  providerLinkId: varchar("provider_link_id", { length: 255 }),
  url: text("url").notNull(),
  amount: integer("amount").notNull(),
  currency: varchar("currency", { length: 10 }).notNull(),
  expiry: timestamp("expiry", { withTimezone: true }),
  status: varchar("status", { length: 50 }).default("created").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Settlements table: Settlement-level financial facts for reconciliation.
 */
export const settlements = pgTable("settlements", {
  id: uuid("id").defaultRandom().primaryKey(),
  providerSettlementId: varchar("provider_settlement_id", { length: 255 }).unique().notNull(),
  paymentId: varchar("payment_id", { length: 255 }),
  gross: integer("gross").notNull(), // amount in lowest currency unit
  fee: integer("fee").notNull(), // gateway MDR fee
  tax: integer("tax").notNull(), // GST on fee
  net: integer("net").notNull(), // gross - fee - tax
  currency: varchar("currency", { length: 10 }).default("INR").notNull(),
  settledAt: timestamp("settled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Reconciliation Items table: Matched or exceptional records between payments, settlements, fees, and bank records.
 */
export const reconItems = pgTable("recon_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  sourceType: varchar("source_type", { length: 50 }).notNull(), // payment, settlement, refund
  sourceId: varchar("source_id", { length: 255 }).notNull(),
  expected: integer("expected").notNull(),
  actual: integer("actual").notNull(),
  difference: integer("difference").notNull(),
  status: reconItemStatusEnum("status").default("pending").notNull(),
  explanation: text("explanation"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Audit Logs table: Immutable product history for trust, security, and financial compliance.
 */
export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  actor: varchar("actor", { length: 255 }).notNull(),
  action: varchar("action", { length: 100 }).notNull(),
  entity: varchar("entity", { length: 100 }).notNull(),
  entityId: varchar("entity_id", { length: 255 }),
  beforeJson: text("before_json"),
  afterJson: text("after_json"),
  requestId: varchar("request_id", { length: 255 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Evaluation Cases table: Held-out evaluation benchmark set for the AI recovery copilot.
 */
export const evalCases = pgTable("eval_cases", {
  id: uuid("id").defaultRandom().primaryKey(),
  scenarioName: varchar("scenario_name", { length: 100 }).notNull(),
  inputJson: text("input_json").notNull(),
  expectedCategory: varchar("expected_category", { length: 100 }).notNull(),
  expectedAction: varchar("expected_action", { length: 100 }).notNull(),
  actualJson: text("actual_json"),
  score: numeric("score", { precision: 5, scale: 2 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// -----------------------------------------------------------------------------
// Relations
// -----------------------------------------------------------------------------

export const merchantsRelations = relations(merchants, ({ many }) => ({
  orders: many(orders),
  customers: many(customers),
}));

export const customersRelations = relations(customers, ({ one }) => ({
  merchant: one(merchants, {
    fields: [customers.merchantId],
    references: [merchants.id],
  }),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  merchant: one(merchants, {
    fields: [orders.merchantId],
    references: [merchants.id],
  }),
  paymentAttempts: many(paymentAttempts),
  paymentCases: many(paymentCases),
}));

export const paymentAttemptsRelations = relations(paymentAttempts, ({ one }) => ({
  order: one(orders, {
    fields: [paymentAttempts.orderId],
    references: [orders.id],
  }),
}));

export const paymentCasesRelations = relations(paymentCases, ({ one, many }) => ({
  order: one(orders, {
    fields: [paymentCases.orderId],
    references: [orders.id],
  }),
  recoveryActions: many(recoveryActions),
  diagnoses: many(diagnoses),
  paymentLinks: many(paymentLinks),
}));

export const diagnosesRelations = relations(diagnoses, ({ one }) => ({
  paymentCase: one(paymentCases, {
    fields: [diagnoses.caseId],
    references: [paymentCases.id],
  }),
}));

export const recoveryActionsRelations = relations(recoveryActions, ({ one }) => ({
  paymentCase: one(paymentCases, {
    fields: [recoveryActions.caseId],
    references: [paymentCases.id],
  }),
}));

export const paymentLinksRelations = relations(paymentLinks, ({ one }) => ({
  paymentCase: one(paymentCases, {
    fields: [paymentLinks.caseId],
    references: [paymentCases.id],
  }),
}));

// -----------------------------------------------------------------------------
// Exported Schema Types
// -----------------------------------------------------------------------------

export type Merchant = typeof merchants.$inferSelect;
export type NewMerchant = typeof merchants.$inferInsert;

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;

export type PaymentAttempt = typeof paymentAttempts.$inferSelect;
export type NewPaymentAttempt = typeof paymentAttempts.$inferInsert;

export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type NewWebhookEvent = typeof webhookEvents.$inferInsert;

export type PaymentCase = typeof paymentCases.$inferSelect;
export type NewPaymentCase = typeof paymentCases.$inferInsert;

export type Diagnosis = typeof diagnoses.$inferSelect;
export type NewDiagnosis = typeof diagnoses.$inferInsert;

export type RecoveryAction = typeof recoveryActions.$inferSelect;
export type NewRecoveryAction = typeof recoveryActions.$inferInsert;

export type PaymentLink = typeof paymentLinks.$inferSelect;
export type NewPaymentLink = typeof paymentLinks.$inferInsert;

export type Settlement = typeof settlements.$inferSelect;
export type NewSettlement = typeof settlements.$inferInsert;

export type ReconItem = typeof reconItems.$inferSelect;
export type NewReconItem = typeof reconItems.$inferInsert;

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;

export type EvalCase = typeof evalCases.$inferSelect;
export type NewEvalCase = typeof evalCases.$inferInsert;

export type MerchantMode = (typeof merchantModeEnum.enumValues)[number];
export type PaymentAttemptStatus = (typeof paymentAttemptStatusEnum.enumValues)[number];
export type PaymentCaseStatus = (typeof paymentCaseStatusEnum.enumValues)[number];
export type RecoveryActionStatus = (typeof recoveryActionStatusEnum.enumValues)[number];
export type ReconItemStatus = (typeof reconItemStatusEnum.enumValues)[number];
