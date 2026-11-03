-- Database-level guarantees that do not depend on application code being correct.

-- 1. Append-only tables: audit log, journals, ledger lines, stock trail, secondary-sales facts.
CREATE OR REPLACE FUNCTION rtm_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table "%" is append-only (% not allowed)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['AuditLog', 'Journal', 'LedgerEntry', 'StockMovement', 'SecondarySale'] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION rtm_forbid_mutation()',
      t || '_append_only', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION rtm_forbid_mutation()',
      t || '_no_truncate', t);
  END LOOP;
END $$;

-- 2. A ledger line is exactly one-sided and non-negative.
ALTER TABLE "LedgerEntry"
  ADD CONSTRAINT "LedgerEntry_one_sided" CHECK (
    "debitPaise" >= 0 AND "creditPaise" >= 0 AND (("debitPaise" = 0) <> ("creditPaise" = 0))
  );

-- 3. Every journal balances. Checked at COMMIT (deferred) so multi-line inserts can complete first.
CREATE OR REPLACE FUNCTION rtm_check_journal_balanced() RETURNS trigger AS $$
DECLARE d bigint; c bigint; n int;
BEGIN
  SELECT COALESCE(SUM("debitPaise"), 0), COALESCE(SUM("creditPaise"), 0), COUNT(*)
    INTO d, c, n
    FROM "LedgerEntry" WHERE "journalId" = NEW."journalId";
  IF d <> c OR n < 2 THEN
    RAISE EXCEPTION 'journal % does not balance (debit %, credit %, lines %)', NEW."journalId", d, c, n
      USING ERRCODE = 'P0002';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "LedgerEntry_balanced"
  AFTER INSERT ON "LedgerEntry"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION rtm_check_journal_balanced();

-- 4. Stock can never go negative.
ALTER TABLE "InventoryBatch" ADD CONSTRAINT "InventoryBatch_non_negative" CHECK ("qtyOnHand" >= 0);
