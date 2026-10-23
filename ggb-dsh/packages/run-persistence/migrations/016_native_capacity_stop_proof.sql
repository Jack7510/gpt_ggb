-- Add proof storage only. Do not infer stops, upgrade checkpoints or rewrite old run facts.
ALTER TABLE runs ADD COLUMN capacity_stop_proof JSONB NULL;
