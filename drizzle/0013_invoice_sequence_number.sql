-- Custom migration: invoices.sequence_number backs a gapless, per-tenant
-- pagination cursor. createInvoice already allocates it via
-- invoice_sequences, but the column never existed, so the value was
-- silently dropped and listInvoices paginated on createdAt instead - which
-- skips rows created in the same millisecond as a page boundary, since JS
-- Date truncates to milliseconds while Postgres stores microseconds.
ALTER TABLE "invoices" ADD COLUMN "sequence_number" bigint;--> statement-breakpoint
UPDATE "invoices" AS i
SET "sequence_number" = backfill.rn
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY created_at, id) AS rn
  FROM "invoices"
) AS backfill
WHERE i.id = backfill.id;--> statement-breakpoint
INSERT INTO "invoice_sequences" (tenant_id, last_value)
SELECT tenant_id, MAX(sequence_number)
FROM "invoices"
GROUP BY tenant_id
ON CONFLICT (tenant_id) DO UPDATE
  SET last_value = GREATEST(invoice_sequences.last_value, EXCLUDED.last_value);--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "sequence_number" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_sequence_number_unique" UNIQUE("tenant_id","sequence_number");
