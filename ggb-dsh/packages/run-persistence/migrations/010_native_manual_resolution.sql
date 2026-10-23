-- Allow one run-private Manual resolution per Plan revision after the original
-- Task Brief/Plan artifact table was introduced.
ALTER TABLE run_native_evidence_artifacts
  DROP CONSTRAINT native_artifact_revision_shape;
ALTER TABLE run_native_evidence_artifacts
  ADD CONSTRAINT native_artifact_revision_shape CHECK (
    (kind = 'task_brief' AND revision IS NULL)
    OR (kind IN ('semantic_plan', 'manual_resolution') AND revision > 0)
  );
ALTER TABLE run_native_evidence_artifacts
  DROP CONSTRAINT run_native_evidence_artifacts_kind_check;
ALTER TABLE run_native_evidence_artifacts
  ADD CONSTRAINT run_native_evidence_artifacts_kind_check
  CHECK (kind IN ('task_brief', 'semantic_plan', 'manual_resolution'));
CREATE UNIQUE INDEX IF NOT EXISTS run_native_manual_revision_idx
  ON run_native_evidence_artifacts (run_id, revision) WHERE kind = 'manual_resolution';
