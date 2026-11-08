CREATE TABLE "audit_crawls" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"run_id" text,
	"dataset_id" text,
	"cost_usd" numeric(12, 6),
	"status" text DEFAULT 'starting' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "audit_crawls_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
ALTER TABLE "audit_crawls" ADD CONSTRAINT "audit_crawls_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_crawls_status_idx" ON "audit_crawls" USING btree ("status");