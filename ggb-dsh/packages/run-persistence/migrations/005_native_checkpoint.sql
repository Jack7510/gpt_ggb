-- Native's evidence index is separate from the existing V3 stage checkpoint.
-- Old V3 rows retain their checkpoint JSON verbatim and have NULL here.
ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS native_checkpoint JSONB;
