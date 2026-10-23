-- Existing rows and legacy writers retain their V3 checkpoint semantics.
ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS pipeline_mode TEXT NOT NULL DEFAULT 'server_owned_v3';

ALTER TABLE runs
  ADD CONSTRAINT runs_pipeline_mode_check
  CHECK (pipeline_mode IN ('server_owned_v3', 'dsh_native_v1'));
