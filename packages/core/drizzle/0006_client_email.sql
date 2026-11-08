DROP INDEX "suppressions_value_uq";--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "agentmail_domain_id" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "dns_records" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_value_client_uq" UNIQUE NULLS NOT DISTINCT("value","client_id");