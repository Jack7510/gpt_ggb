-- The migration runner wraps this file in one transaction. Block concurrent
-- receipt writes while checking historical rows and creating the index.
LOCK TABLE execution_receipts IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  conflicting_phases BIGINT;
BEGIN
  SELECT COUNT(*) INTO conflicting_phases
  FROM (
    SELECT 1
    FROM execution_receipts
    GROUP BY run_id, transaction_id, phase
    HAVING COUNT(*) > 1
  ) AS conflicts;
  IF conflicting_phases > 0 THEN
    RAISE EXCEPTION 'execution_receipts has % conflicting phase group(s); resolve before migration', conflicting_phases;
  END IF;
END
$$;

CREATE UNIQUE INDEX execution_receipts_one_body_per_phase
  ON execution_receipts (run_id, transaction_id, phase);
