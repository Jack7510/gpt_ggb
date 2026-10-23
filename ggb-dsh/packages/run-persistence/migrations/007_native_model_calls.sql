-- One physical SDK model step per row. Missing usage is represented by NULL,
-- never by fabricated zeroes. Run deletion/TTL cascades to this table.
CREATE TABLE IF NOT EXISTS run_model_calls (
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  turn_id UUID NOT NULL,
  call_ordinal INTEGER NOT NULL CHECK (call_ordinal BETWEEN 1 AND 32),
  granularity TEXT NOT NULL CHECK (granularity = 'call'),
  model_id TEXT NOT NULL,
  model_policy_version TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL,
  reserved_tokens INTEGER NOT NULL CHECK (reserved_tokens > 0),
  status TEXT NOT NULL CHECK (status IN ('started','completed','interrupted','unknown')),
  usage_source TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  reasoning_tokens INTEGER,
  cache_read_tokens INTEGER,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  PRIMARY KEY (run_id, turn_id, call_ordinal)
);

CREATE INDEX IF NOT EXISTS run_model_calls_run_time_idx ON run_model_calls (run_id, started_at);
