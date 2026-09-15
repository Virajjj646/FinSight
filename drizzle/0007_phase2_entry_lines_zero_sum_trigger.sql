-- Custom migration: enforce that every journal entry's lines sum to zero,
-- as a deferred constraint trigger checked at commit time. This is the
-- database-level guarantee; the application-level check in
-- createJournalEntryTx is only the friendly error message for the common
-- path.
CREATE OR REPLACE FUNCTION check_entry_lines_balance() RETURNS TRIGGER AS $$
DECLARE
  v_entry_id uuid;
  v_sum numeric;
BEGIN
  v_entry_id := COALESCE(NEW.entry_id, OLD.entry_id);

  SELECT COALESCE(SUM(amount_minor), 0)
  INTO v_sum
  FROM entry_lines
  WHERE entry_id = v_entry_id;

  IF v_sum <> 0 THEN
    RAISE EXCEPTION 'entry_lines for entry_id % do not balance to zero (sum = %)', v_entry_id, v_sum
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER entry_lines_zero_sum_trigger
AFTER INSERT OR UPDATE OR DELETE ON entry_lines
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION check_entry_lines_balance();
