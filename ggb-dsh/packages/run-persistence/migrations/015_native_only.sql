-- Native-only schema. Apply only after an authorized backup and legacy-data review.
-- No run conversion, row deletion or nonempty historical-data removal is permitted.
LOCK TABLE runs, run_stage_artifacts IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM runs WHERE pipeline_mode IS DISTINCT FROM 'dsh_native_v1')
    OR EXISTS (SELECT 1 FROM runs WHERE checkpoint IS NOT NULL AND checkpoint <> 'null'::jsonb)
    OR EXISTS (SELECT 1 FROM run_stage_artifacts) THEN
    RAISE EXCEPTION 'native_schema_legacy_data_requires_review';
  END IF;
  IF EXISTS (SELECT 1 FROM runs WHERE (
    jsonb_typeof(native_checkpoint) = 'object'
    AND native_checkpoint->>'pipelineMode' = 'dsh_native_v1'
    AND native_checkpoint->>'schemaVersion' IN ('1', '2')
  ) IS NOT TRUE) THEN
    RAISE EXCEPTION 'native_schema_checkpoint_requires_review';
  END IF;
END;
$$;

ALTER TABLE runs DROP CONSTRAINT runs_pipeline_mode_check;
ALTER TABLE runs ALTER COLUMN pipeline_mode SET DEFAULT 'dsh_native_v1';
ALTER TABLE runs ADD CONSTRAINT runs_pipeline_mode_check CHECK (pipeline_mode = 'dsh_native_v1');
ALTER TABLE runs ALTER COLUMN native_checkpoint SET NOT NULL;
ALTER TABLE runs ADD CONSTRAINT runs_native_checkpoint_check CHECK ((
  jsonb_typeof(native_checkpoint) = 'object'
  AND native_checkpoint->>'pipelineMode' = 'dsh_native_v1'
  AND native_checkpoint->>'schemaVersion' IN ('1', '2')
) IS TRUE);
ALTER TABLE runs DROP COLUMN checkpoint;
DROP TABLE run_stage_artifacts;
