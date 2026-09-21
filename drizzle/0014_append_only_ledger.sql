-- Custom migration: the ledger is append-only. Posted entries and lines are
-- corrected by reversal, never by editing or removing history. entry_lines
-- may never be updated or deleted; journal_entries may never be deleted, and
-- may only be updated once, to set reversed_by_entry_id from NULL to a
-- value, with every other column unchanged.
CREATE OR REPLACE FUNCTION reject_entry_lines_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'entry_lines is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER entry_lines_append_only
BEFORE UPDATE OR DELETE ON entry_lines
FOR EACH ROW
EXECUTE FUNCTION reject_entry_lines_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_journal_entries_mutation() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'journal_entries is append-only: DELETE is not allowed'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.reversed_by_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'journal_entries.reversed_by_entry_id can only be set once'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.reversed_by_entry_id IS NULL
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.description IS DISTINCT FROM OLD.description
     OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
  THEN
    RAISE EXCEPTION 'journal_entries rows are append-only except for setting reversed_by_entry_id once'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER journal_entries_append_only
BEFORE UPDATE OR DELETE ON journal_entries
FOR EACH ROW
EXECUTE FUNCTION reject_journal_entries_mutation();
