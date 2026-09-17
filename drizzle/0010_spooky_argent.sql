ALTER TABLE "invoice_payments" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD COLUMN "idempotency_key" varchar(255) NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD COLUMN "request_fingerprint" varchar(64) NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_tenant_id_idempotency_key_unique" UNIQUE("tenant_id","idempotency_key");