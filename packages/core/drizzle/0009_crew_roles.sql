ALTER TYPE "public"."agent_name" ADD VALUE 'account_manager' BEFORE 'ceo';--> statement-breakpoint
ALTER TYPE "public"."agent_name" ADD VALUE 'signal_scout' BEFORE 'ceo';--> statement-breakpoint
ALTER TYPE "public"."agent_name" ADD VALUE 'experimenter' BEFORE 'ceo';--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "crew_roles" text[] DEFAULT '{orchestrator,prospector,researcher,sdr,closer,auditor}'::text[] NOT NULL;