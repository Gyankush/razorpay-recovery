CREATE TABLE "autopilot_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"allowed_categories" text DEFAULT '["customer_action","transient"]' NOT NULL,
	"max_auto_amount" integer DEFAULT 10000 NOT NULL,
	"max_actions_per_run" integer DEFAULT 10 NOT NULL,
	"min_confidence" numeric(5, 2) DEFAULT '0.70',
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "autopilot_policies_merchant_id_unique" UNIQUE("merchant_id")
);
--> statement-breakpoint
ALTER TABLE "autopilot_policies" ADD CONSTRAINT "autopilot_policies_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "autopilot_policies_merchant_id_idx" ON "autopilot_policies" USING btree ("merchant_id");