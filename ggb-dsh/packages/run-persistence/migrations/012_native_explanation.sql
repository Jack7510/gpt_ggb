-- A Native explanation is a private, immutable evidence artifact. Its active
-- digest is indexed by the Native checkpoint and its producing tool outcome.
ALTER TABLE run_native_evidence_artifacts
  DROP CONSTRAINT native_artifact_revision_shape;
ALTER TABLE run_native_evidence_artifacts
  ADD CONSTRAINT native_artifact_revision_shape CHECK (
    (kind IN ('task_brief', 'explanation') AND revision IS NULL)
    OR (kind IN ('semantic_plan', 'manual_resolution', 'candidate_program') AND revision > 0)
  );
ALTER TABLE run_native_evidence_artifacts
  DROP CONSTRAINT run_native_evidence_artifacts_kind_check;
ALTER TABLE run_native_evidence_artifacts
  ADD CONSTRAINT run_native_evidence_artifacts_kind_check
  CHECK (kind IN ('task_brief', 'semantic_plan', 'manual_resolution', 'candidate_program', 'explanation'));
CREATE UNIQUE INDEX IF NOT EXISTS run_native_explanation_tool_idx
  ON run_native_evidence_artifacts (run_id, tool_call_id) WHERE kind = 'explanation';
