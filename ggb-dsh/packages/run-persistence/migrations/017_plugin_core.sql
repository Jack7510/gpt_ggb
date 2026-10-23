-- Independent plugin-core run lifecycle. This is deliberately separate from the
-- Native runs/checkpoint/transaction tables so the fallback remains unchanged.

CREATE TABLE IF NOT EXISTS plugin_core_runs (
  run_id                TEXT PRIMARY KEY,
  token_verifier        TEXT NOT NULL,
  request_digest        TEXT NOT NULL,
  prompt                TEXT NOT NULL,
  prompt_digest         TEXT NOT NULL,
  base_sha256           TEXT,
  base_name             TEXT,
  phase                 TEXT NOT NULL CHECK (phase IN (
    'accepted', 'running', 'completed', 'failed', 'cancelled'
  )),
  stop_requested        BOOLEAN NOT NULL DEFAULT FALSE,
  execution_started_at  TIMESTAMPTZ,
  execution_expires_at  TIMESTAMPTZ NOT NULL,
  final_response        TEXT,
  failure               JSONB,
  delivery              JSONB,
  usage                 JSONB,
  duration_ms           BIGINT,
  model_id              TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at            TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS plugin_core_runs_active_idx
  ON plugin_core_runs (phase, execution_expires_at);
CREATE INDEX IF NOT EXISTS plugin_core_runs_expiry_idx
  ON plugin_core_runs (expires_at) WHERE phase IN ('completed', 'failed', 'cancelled');

CREATE TABLE IF NOT EXISTS plugin_core_events (
  run_id      TEXT NOT NULL REFERENCES plugin_core_runs(run_id) ON DELETE CASCADE,
  event_id    BIGINT NOT NULL,
  payload     JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (run_id, event_id)
);

CREATE TABLE IF NOT EXISTS plugin_core_artifacts (
  run_id         TEXT NOT NULL REFERENCES plugin_core_runs(run_id) ON DELETE CASCADE,
  artifact_id    TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN (
    'result_ggb', 'preview', 'verification', 'manifest'
  )),
  size_bytes     BIGINT NOT NULL,
  sha256         TEXT NOT NULL,
  content_type   TEXT NOT NULL,
  content_base64 TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (run_id, artifact_id)
);

CREATE TABLE IF NOT EXISTS plugin_core_usage (
  run_id            TEXT PRIMARY KEY REFERENCES plugin_core_runs(run_id) ON DELETE CASCADE,
  calls             INTEGER NOT NULL,
  input_tokens      BIGINT,
  output_tokens     BIGINT,
  reasoning_tokens  BIGINT,
  cache_read_tokens BIGINT,
  complete          BOOLEAN NOT NULL,
  usage_source      TEXT NOT NULL,
  model_id          TEXT NOT NULL,
  prompt_digest     TEXT NOT NULL,
  duration_ms       BIGINT,
  error_code        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
