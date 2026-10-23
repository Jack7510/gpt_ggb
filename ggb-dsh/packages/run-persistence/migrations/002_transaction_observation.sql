-- §8.1: browser execution observation projected onto the transaction record so
-- semantic_validation consumes real observation evidence (not just state).

ALTER TABLE execution_transactions ADD COLUMN IF NOT EXISTS observation JSONB;