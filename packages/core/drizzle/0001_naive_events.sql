ALTER TYPE "public"."stop_reason" ADD VALUE 'awaiting_answer' BEFORE 'budget_paused';--> statement-breakpoint
ALTER TYPE "public"."stop_reason" ADD VALUE 'awaiting_delegation' BEFORE 'budget_paused';--> statement-breakpoint
ALTER TYPE "public"."stop_reason" ADD VALUE 'context_exhausted' BEFORE 'interrupted';--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "last_seq" integer DEFAULT 0 NOT NULL;