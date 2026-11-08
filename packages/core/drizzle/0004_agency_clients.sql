CREATE TYPE "public"."client_status" AS ENUM('draft', 'profiling', 'awaiting_confirmation', 'email_setup', 'active', 'paused');--> statement-breakpoint
CREATE TABLE "client_users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'approver' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"domain" text NOT NULL,
	"status" "client_status" DEFAULT 'draft' NOT NULL,
	"profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"profile_confirmed_at" timestamp with time zone,
	"confirmed_by" text,
	"agentmail_inbox_id" text,
	"sending_domain" text,
	"dns_status" text DEFAULT 'none' NOT NULL,
	"daily_send_cap" integer DEFAULT 30 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Outrun is client #0: every row from before clients existed is its own.
INSERT INTO "clients" ("id", "slug", "name", "domain", "status", "profile_confirmed_at", "confirmed_by")
VALUES ('00000000-0000-7000-8000-000000000000', 'outrun', 'Outrun', 'outrun', 'active', now(), 'migration')
ON CONFLICT DO NOTHING;--> statement-breakpoint
DROP INDEX "prospects_company_uq";--> statement-breakpoint
DROP INDEX "agent_sessions_live_uq";--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "client_id" uuid DEFAULT '00000000-0000-7000-8000-000000000000' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "client_id" uuid DEFAULT '00000000-0000-7000-8000-000000000000' NOT NULL;--> statement-breakpoint
ALTER TABLE "prospects" ADD COLUMN "client_id" uuid DEFAULT '00000000-0000-7000-8000-000000000000' NOT NULL;--> statement-breakpoint
ALTER TABLE "suppressions" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "client_users" ADD CONSTRAINT "client_users_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "client_users_client_email_uq" ON "client_users" USING btree ("client_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "clients_slug_uq" ON "clients" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "clients_domain_uq" ON "clients" USING btree ("domain");--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospects" ADD CONSTRAINT "prospects_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_client_idx" ON "messages" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "prospects_client_company_uq" ON "prospects" USING btree ("client_id","company_id");--> statement-breakpoint
CREATE INDEX "prospects_client_idx" ON "prospects" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_sessions_live_uq" ON "agent_sessions" USING btree ("client_id","agent","entity_type","entity_id") WHERE "agent_sessions"."status" in ('starting','running','idle');