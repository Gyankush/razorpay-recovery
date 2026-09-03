CREATE TYPE "public"."recon_item_status" AS ENUM('matched', 'discrepancy', 'pending', 'resolved');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" varchar(255) NOT NULL,
	"action" varchar(100) NOT NULL,
	"entity" varchar(100) NOT NULL,
	"entity_id" varchar(255),
	"before_json" text,
	"after_json" text,
	"request_id" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"email_hash" varchar(255),
	"country" varchar(10) DEFAULT 'US',
	"currency" varchar(10) DEFAULT 'USD',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "diagnoses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"category" varchar(100) NOT NULL,
	"facts_json" text NOT NULL,
	"explanation" text NOT NULL,
	"model" varchar(100) DEFAULT 'rule-engine-v1',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scenario_name" varchar(100) NOT NULL,
	"input_json" text NOT NULL,
	"expected_category" varchar(100) NOT NULL,
	"expected_action" varchar(100) NOT NULL,
	"actual_json" text,
	"score" numeric(5, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"provider_link_id" varchar(255),
	"url" text NOT NULL,
	"amount" integer NOT NULL,
	"currency" varchar(10) NOT NULL,
	"expiry" timestamp with time zone,
	"status" varchar(50) DEFAULT 'created' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recon_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_type" varchar(50) NOT NULL,
	"source_id" varchar(255) NOT NULL,
	"expected" integer NOT NULL,
	"actual" integer NOT NULL,
	"difference" integer NOT NULL,
	"status" "recon_item_status" DEFAULT 'pending' NOT NULL,
	"explanation" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_settlement_id" varchar(255) NOT NULL,
	"payment_id" varchar(255),
	"gross" integer NOT NULL,
	"fee" integer NOT NULL,
	"tax" integer NOT NULL,
	"net" integer NOT NULL,
	"currency" varchar(10) DEFAULT 'INR' NOT NULL,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlements_provider_settlement_id_unique" UNIQUE("provider_settlement_id")
);
--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "encrypted_key_ref" text;--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "timezone" varchar(50) DEFAULT 'Asia/Kolkata';--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "policy_id" varchar(50) DEFAULT 'default_v1';--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD COLUMN "method" varchar(50) DEFAULT 'card';--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD COLUMN "country" varchar(10) DEFAULT 'US';--> statement-breakpoint
ALTER TABLE "recovery_actions" ADD COLUMN "result_json" text;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnoses" ADD CONSTRAINT "diagnoses_case_id_payment_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."payment_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_case_id_payment_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."payment_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor");--> statement-breakpoint
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "diagnoses_case_id_idx" ON "diagnoses" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "payment_links_case_id_idx" ON "payment_links" USING btree ("case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recon_items_source_unique" ON "recon_items" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "recon_items_status_idx" ON "recon_items" USING btree ("status");--> statement-breakpoint
CREATE INDEX "settlements_payment_id_idx" ON "settlements" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_external_order_id_unique" ON "orders" USING btree ("external_order_id");--> statement-breakpoint
CREATE INDEX "orders_merchant_id_idx" ON "orders" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "orders_created_at_idx" ON "orders" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_provider_payment_id_unique" ON "payment_attempts" USING btree ("provider_payment_id");--> statement-breakpoint
CREATE INDEX "payment_attempts_order_id_idx" ON "payment_attempts" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "payment_attempts_status_idx" ON "payment_attempts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "payment_cases_order_id_idx" ON "payment_cases" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "payment_cases_status_idx" ON "payment_cases" USING btree ("status");--> statement-breakpoint
CREATE INDEX "payment_cases_created_at_idx" ON "payment_cases" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "recovery_actions_case_id_idx" ON "recovery_actions" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "webhook_events_event_type_idx" ON "webhook_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "webhook_events_processed_idx" ON "webhook_events" USING btree ("processed");