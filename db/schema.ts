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
  index,
  uniqueIndex,
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
  providerAccountId: varchar("provider_account_id", { length: 100 }).unique(),
  contactEmail: varchar("contact_email", { length: 255 }),
  webhookUrl: text("webhook_url"),
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
export const orders = pgTable(
  "orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    merchantId: uuid("merchant_id")
      .references(() => merchants.id, { onDelete: "cascade" })
      .notNull(),
    externalOrderId: varchar("external_order_id", { length: 255 }).notNull(),
    amount: integer("amount").notNull(), // amount in lowest currency unit (cents / paise)
    currency: varchar("currency", { length: 10 }).notNull(),
    status: varchar("status", { length: 50 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("orders_external_order_id_unique").on(t.externalOrderId),
    index("orders_merchant_id_idx").on(t.merchantId),
    index("orders_created_at_idx").on(t.createdAt),
  ]
);

/**
 * Payment Attempts table: Tracks every payment attempt per order with gateway references and status.
 */
export const paymentAttempts = pgTable(
  "payment_attempts",
  {
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
  },
  (t) => [
    uniqueIndex("payment_attempts_provider_payment_id_unique").on(
      t.providerPaymentId
    ),
    index("payment_attempts_order_id_idx").on(t.orderId),
    index("payment_attempts_status_idx").on(t.status),
  ]
);

/**
 * Webhook Events table: Replayable and auditable source of truth for incoming gateway webhooks.
 */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    providerEventId: varchar("provider_event_id", { length: 255 }).unique().notNull(),
    eventType: varchar("event_type", { length: 100 }).notNull(),
    rawBody: text("raw_body").notNull(),
    signatureValid: boolean("signature_valid").default(false).notNull(),
    processed: boolean("processed").default(false).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("webhook_events_event_type_idx").on(t.eventType),
    index("webhook_events_processed_idx").on(t.processed),
  ]
);

/**
 * Payment Cases table: Work items opened when an order failure or ambiguity requires diagnosis & resolution.
 */
export const paymentCases = pgTable(
  "payment_cases",
  {
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
  },
  (t) => [
    index("payment_cases_order_id_idx").on(t.orderId),
    index("payment_cases_status_idx").on(t.status),
    index("payment_cases_created_at_idx").on(t.createdAt),
  ]
);

/**
 * Diagnoses table: Versioned explanations and observed facts for a payment case.
 */
export const diagnoses = pgTable(
  "diagnoses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    caseId: uuid("case_id")
      .references(() => paymentCases.id, { onDelete: "cascade" })
      .notNull(),
    category: varchar("category", { length: 100 }).notNull(),
    factsJson: text("facts_json").notNull(), // JSON stringified array of facts
    explanation: text("explanation").notNull(),
    model: varchar("model", { length: 100 }).default("rule-engine-v1"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("diagnoses_case_id_idx").on(t.caseId)]
);

/**
 * Recovery Actions table: Bounded recovery steps (proposed, approved, rejected, executed) with idempotency.
 */
export const recoveryActions = pgTable(
  "recovery_actions",
  {
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
  },
  (t) => [index("recovery_actions_case_id_idx").on(t.caseId)]
);

/**
 * Payment Links table: Fallback recovery links and their lifecycles.
 */
export const paymentLinks = pgTable(
  "payment_links",
  {
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
  },
  (t) => [index("payment_links_case_id_idx").on(t.caseId)]
);

/**
 * Settlements table: Settlement-level financial facts for reconciliation.
 */
export const settlements = pgTable(
  "settlements",
  {
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
  },
  (t) => [index("settlements_payment_id_idx").on(t.paymentId)]
);

/**
 * Reconciliation Items table: Matched or exceptional records between payments, settlements, fees, and bank records.
 */
export const reconItems = pgTable(
  "recon_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceType: varchar("source_type", { length: 50 }).notNull(), // payment, settlement, refund
    sourceId: varchar("source_id", { length: 255 }).notNull(),
    expected: integer("expected").notNull(),
    actual: integer("actual").notNull(),
    difference: integer("difference").notNull(),
    status: reconItemStatusEnum("status").default("pending").notNull(),
    explanation: text("explanation"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("recon_items_source_unique").on(t.sourceType, t.sourceId),
    index("recon_items_status_idx").on(t.status),
  ]
);

/**
 * Audit Logs table: Immutable product history for trust, security, and financial compliance.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actor: varchar("actor", { length: 255 }).notNull(),
    action: varchar("action", { length: 100 }).notNull(),
    entity: varchar("entity", { length: 100 }).notNull(),
    entityId: varchar("entity_id", { length: 255 }),
    beforeJson: text("before_json"),
    afterJson: text("after_json"),
    requestId: varchar("request_id", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("audit_logs_entity_idx").on(t.entity),
    index("audit_logs_actor_idx").on(t.actor),
    index("audit_logs_created_at_idx").on(t.createdAt),
  ]
);

/**
 * Autopilot Policies table: per-merchant autonomy guardrails for the
 * autonomous recovery agent. Disabled by default; when enabled, the agent
 * may only auto-execute allowlisted categories under a per-order amount cap.
 */
export const autopilotPolicies = pgTable(
  "autopilot_policies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    merchantId: uuid("merchant_id")
      .references(() => merchants.id, { onDelete: "cascade" })
      .unique()
      .notNull(),
    enabled: boolean("enabled").default(false).notNull(),
    allowedCategories: text("allowed_categories")
      .default('["customer_action","transient"]')
      .notNull(), // JSON array of failure categories the agent may auto-handle
    maxAutoAmount: integer("max_auto_amount").default(10000).notNull(), // cents/paise cap per order
    maxActionsPerRun: integer("max_actions_per_run").default(10).notNull(),
    minConfidence: numeric("min_confidence", { precision: 5, scale: 2 }).default("0.70"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("autopilot_policies_merchant_id_idx").on(t.merchantId)]
);

/**
 * Notifications table: durable outbox for merchant-facing alerts
 * (case opened, link created/paid/expired, agent run summary).
 * Delivery is attempted to the merchant's webhookUrl; without one,
 * rows stay `queued` as an auditable outbox instead of fake `sent`.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    merchantId: uuid("merchant_id")
      .references(() => merchants.id, { onDelete: "cascade" })
      .notNull(),
    caseId: uuid("case_id").references(() => paymentCases.id, {
      onDelete: "set null",
    }),
    type: varchar("type", { length: 100 }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    body: text("body").notNull(),
    status: varchar("status", { length: 50 }).default("queued").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    lastError: text("last_error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("notifications_merchant_id_idx").on(t.merchantId),
    index("notifications_status_idx").on(t.status),
  ]
);

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

export type AutopilotPolicy = typeof autopilotPolicies.$inferSelect;
export type NewAutopilotPolicy = typeof autopilotPolicies.$inferInsert;

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;

export type MerchantMode = (typeof merchantModeEnum.enumValues)[number];
export type PaymentAttemptStatus = (typeof paymentAttemptStatusEnum.enumValues)[number];
export type PaymentCaseStatus = (typeof paymentCaseStatusEnum.enumValues)[number];
export type RecoveryActionStatus = (typeof recoveryActionStatusEnum.enumValues)[number];
export type ReconItemStatus = (typeof reconItemStatusEnum.enumValues)[number];
