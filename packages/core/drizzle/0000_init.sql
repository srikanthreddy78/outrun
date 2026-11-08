CREATE TYPE "public"."agent_name" AS ENUM('orchestrator', 'prospector', 'researcher', 'sdr', 'closer', 'auditor');--> statement-breakpoint
CREATE TYPE "public"."company_kind" AS ENUM('candidate', 'prospect');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('outbound', 'inbound');--> statement-breakpoint
CREATE TYPE "public"."message_kind" AS ENUM('first', 'followup', 'reply', 'transactional', 'inbound');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('checked', 'awaiting_approval', 'approved', 'sending', 'sent', 'rejected', 'failed', 'received');--> statement-breakpoint
CREATE TYPE "public"."order_state" AS ENUM('pending', 'paid', 'auditing', 'delivered', 'failed', 'canceled', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."product" AS ENUM('freeScan', 'auditKit', 'growth');--> statement-breakpoint
CREATE TYPE "public"."prospect_stage" AS ENUM('filed', 'researched', 'drafted', 'contacted', 'replied', 'interested', 'checkout_sent', 'won', 'not_now', 'lost', 'unsubscribed');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('starting', 'running', 'idle', 'terminated', 'error');--> statement-breakpoint
CREATE TYPE "public"."source" AS ENUM('mcp_registry', 'glama', 'apify', 'producthunt', 'yc', 'manual', 'fixture');--> statement-breakpoint
CREATE TYPE "public"."stop_reason" AS ENUM('end_turn', 'awaiting_input', 'awaiting_approval', 'budget_paused', 'interrupted', 'max_iterations', 'error');--> statement-breakpoint
CREATE TABLE "agent_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" text,
	"agent" "agent_name" NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "session_status" DEFAULT 'starting' NOT NULL,
	"stop_reason" "stop_reason",
	"spend_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"last_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"domain" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"source" "source" NOT NULL,
	"source_ref" text,
	"kind" "company_kind" DEFAULT 'candidate' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role" text DEFAULT '' NOT NULL,
	"email" text NOT NULL,
	"source_url" text NOT NULL,
	"consent" text DEFAULT 'legitimate_interest_business' NOT NULL,
	"suppressed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"type" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"prospect_id" uuid,
	"contact_id" uuid,
	"thread_id" text,
	"direction" "message_direction" NOT NULL,
	"kind" "message_kind" NOT NULL,
	"status" "message_status" NOT NULL,
	"to_email" text,
	"from_email" text,
	"subject" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"cited_check_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"draft_hash" text,
	"provider_id" text,
	"naive_session_id" text,
	"naive_tool_call_id" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"prospect_id" uuid,
	"domain" text NOT NULL,
	"contact_email" text NOT NULL,
	"product" "product" NOT NULL,
	"state" "order_state" DEFAULT 'pending' NOT NULL,
	"amount_usd" numeric(10, 2) NOT NULL,
	"idempotency_key" text,
	"stripe_checkout_id" text,
	"stripe_payment_intent_id" text,
	"stripe_subscription_id" text,
	"paid_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prospects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"contact_id" uuid,
	"stage" "prospect_stage" DEFAULT 'filed' NOT NULL,
	"facts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fit_score" real,
	"gap_score" real,
	"filed_reason" text DEFAULT '' NOT NULL,
	"last_contacted_at" timestamp with time zone,
	"followup_step" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"access_token" text NOT NULL,
	"audit" jsonb NOT NULL,
	"kit" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"domain" text NOT NULL,
	"version" integer NOT NULL,
	"scanner_version" text NOT NULL,
	"score" real NOT NULL,
	"checks" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospects" ADD CONSTRAINT "prospects_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospects" ADD CONSTRAINT "prospects_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_sessions_session_uq" ON "agent_sessions" USING btree ("session_id") WHERE "agent_sessions"."session_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_sessions_idem_uq" ON "agent_sessions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_sessions_live_uq" ON "agent_sessions" USING btree ("agent","entity_type","entity_id") WHERE "agent_sessions"."status" in ('starting','running','idle');--> statement-breakpoint
CREATE UNIQUE INDEX "companies_domain_uq" ON "companies" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "companies_kind_idx" ON "companies" USING btree ("kind");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_email_uq" ON "contacts" USING btree ("email");--> statement-breakpoint
CREATE INDEX "contacts_company_idx" ON "contacts" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "events_ts_idx" ON "events" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "events_entity_idx" ON "events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "events_type_ts_idx" ON "events" USING btree ("type","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "events_webhook_uq" ON "events" USING btree ("entity_id") WHERE "events"."type" = 'webhook.received';--> statement-breakpoint
CREATE UNIQUE INDEX "messages_provider_uq" ON "messages" USING btree ("provider_id") WHERE "messages"."provider_id" is not null;--> statement-breakpoint
CREATE INDEX "messages_thread_idx" ON "messages" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "messages_status_idx" ON "messages" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_idem_uq" ON "orders" USING btree ("idempotency_key") WHERE "orders"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_checkout_uq" ON "orders" USING btree ("stripe_checkout_id") WHERE "orders"."stripe_checkout_id" is not null;--> statement-breakpoint
CREATE INDEX "orders_state_idx" ON "orders" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "prospects_company_uq" ON "prospects" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "prospects_stage_idx" ON "prospects" USING btree ("stage");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_token_uq" ON "reports" USING btree ("access_token");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_order_uq" ON "reports" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scans_domain_version_uq" ON "scans" USING btree ("domain","version");--> statement-breakpoint
CREATE UNIQUE INDEX "suppressions_value_uq" ON "suppressions" USING btree ("value");