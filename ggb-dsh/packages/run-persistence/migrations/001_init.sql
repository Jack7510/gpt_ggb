-- V3 run store schema (docs/ggb-agent-v3-tech.md §5).
-- No users/tenants/sessions: only run-scoped facts.

CREATE TABLE IF NOT EXISTS runs (
  run_id            TEXT PRIMARY KEY,
  token_verifier    TEXT NOT NULL,
  request_digest    TEXT NOT NULL,
  prompt            TEXT NOT NULL,
  conversation_context JSONB NOT NULL DEFAULT '[]'::jsonb,
  canvas_context    JSONB,
  has_image         BOOLEAN NOT NULL DEFAULT FALSE,
  phase             TEXT NOT NULL,
  stop_requested    BOOLEAN NOT NULL DEFAULT FALSE,
  worker_id         TEXT,
  lease_epoch       INTEGER NOT NULL DEFAULT 0,
  lease_expires_at  TIMESTAMPTZ,
  release_vector    JSONB NOT NULL,
  checkpoint        JSONB NOT NULL,
  pending_question  JSONB,
  failure           JSONB,
  final_message     TEXT,
  final_canvas_version TEXT,
  final_canvas_digest  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS runs_phase_idx ON runs (phase);
CREATE INDEX IF NOT EXISTS runs_expiry_idx ON runs (expires_at) WHERE phase IN ('completed','failed','cancelled');

CREATE TABLE IF NOT EXISTS run_stage_artifacts (
  run_id        TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  stage         TEXT NOT NULL,
  attempt       INTEGER NOT NULL,
  payload_digest TEXT NOT NULL,
  payload       JSONB NOT NULL,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, stage, attempt)
);

CREATE TABLE IF NOT EXISTS run_events (
  run_id     TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  event_id   BIGINT NOT NULL,
  payload    JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (run_id, event_id)
);

CREATE TABLE IF NOT EXISTS run_user_answers (
  run_id       TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  question_id  TEXT NOT NULL,
  answer       TEXT NOT NULL,
  answer_digest TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, question_id)
);

CREATE TABLE IF NOT EXISTS execution_transactions (
  run_id      TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  transaction_id TEXT NOT NULL,
  transaction JSONB NOT NULL,
  expected_canvas_digest TEXT NOT NULL,
  script      TEXT NOT NULL,
  state       TEXT NOT NULL,
  worker_epoch INTEGER NOT NULL,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  result_canvas_digest TEXT,
  PRIMARY KEY (run_id, transaction_id)
);

CREATE TABLE IF NOT EXISTS execution_receipts (
  run_id         TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  transaction_id TEXT NOT NULL,
  phase          TEXT NOT NULL,
  body_digest    TEXT NOT NULL,
  payload        JSONB NOT NULL,
  worker_epoch   INTEGER,
  recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, transaction_id, phase, body_digest)
);

CREATE TABLE IF NOT EXISTS artifacts (
  run_id       TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  artifact_id  TEXT NOT NULL,
  kind         TEXT NOT NULL,
  size_bytes   BIGINT NOT NULL,
  sha256       TEXT NOT NULL,
  content_type TEXT NOT NULL,
  content_base64 TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (run_id, artifact_id)
);

CREATE TABLE IF NOT EXISTS diagnostic_records (
  run_id      TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS diagnostic_run_idx ON diagnostic_records (run_id, created_at);
