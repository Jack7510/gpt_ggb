-- A browser-selected, bounded history hint for a new run. No old run id or token.
ALTER TABLE runs ADD COLUMN failed_run_context JSONB NULL;
