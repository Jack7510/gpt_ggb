-- Native evidence bodies are private run-scoped facts, committed in the same
-- transaction as their producing tool result and checkpoint digest.
CREATE TABLE IF NOT EXISTS run_native_evidence_artifacts (
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  digest TEXT NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  tool_call_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('task_brief', 'semantic_plan')),
  revision INTEGER,
  body JSONB NOT NULL,
  PRIMARY KEY (run_id, digest),
  CONSTRAINT native_artifact_revision_shape CHECK (
    (kind = 'task_brief' AND revision IS NULL)
    OR (kind = 'semantic_plan' AND revision > 0)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS run_native_one_task_brief_idx
  ON run_native_evidence_artifacts (run_id) WHERE kind = 'task_brief';
CREATE UNIQUE INDEX IF NOT EXISTS run_native_plan_revision_idx
  ON run_native_evidence_artifacts (run_id, revision) WHERE kind = 'semantic_plan';
