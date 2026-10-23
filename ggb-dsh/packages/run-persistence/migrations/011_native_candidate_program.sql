-- Candidate Program bodies are bound to the Native ggb_apply tool outcome and
-- signed transaction in one transaction. A run may submit a revised program.
ALTER TABLE run_native_evidence_artifacts
  DROP CONSTRAINT native_artifact_revision_shape;
ALTER TABLE run_native_evidence_artifacts
  ADD CONSTRAINT native_artifact_revision_shape CHECK (
    (kind = 'task_brief' AND revision IS NULL)
    OR (kind IN ('semantic_plan', 'manual_resolution', 'candidate_program') AND revision > 0)
  );
ALTER TABLE run_native_evidence_artifacts
  DROP CONSTRAINT run_native_evidence_artifacts_kind_check;
ALTER TABLE run_native_evidence_artifacts
  ADD CONSTRAINT run_native_evidence_artifacts_kind_check
  CHECK (kind IN ('task_brief', 'semantic_plan', 'manual_resolution', 'candidate_program'));
CREATE UNIQUE INDEX IF NOT EXISTS run_native_candidate_program_tool_idx
  ON run_native_evidence_artifacts (run_id, tool_call_id) WHERE kind = 'candidate_program';
