ALTER TYPE "public"."source" ADD VALUE 'hunter';--> statement-breakpoint
CREATE TABLE "client_candidates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"source" "source" NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_candidates" ADD CONSTRAINT "client_candidates_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_candidates" ADD CONSTRAINT "client_candidates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "client_candidates_uq" ON "client_candidates" USING btree ("client_id","company_id");