CREATE TABLE "invoice_sequences" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"last_value" bigint DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoice_sequences" ADD CONSTRAINT "invoice_sequences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;