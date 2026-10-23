-- Reservations precede tool execution. They are scoped to one run and removed
-- by the existing run TTL/janitor through ON DELETE CASCADE.
CREATE TABLE IF NOT EXISTS run_tool_attempts (
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  turn_id UUID NOT NULL,
  tool_call_id UUID NOT NULL,
  tool_name TEXT NOT NULL,
  arguments_digest TEXT NOT NULL CHECK (arguments_digest ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('started', 'accepted', 'rejected', 'waiting_for_canvas', 'settled', 'recovery_required')),
  lease_epoch INTEGER NOT NULL,
  release_vector JSONB NOT NULL,
  result JSONB,
  result_digest TEXT,
  transaction_id TEXT,
  plan_revision INTEGER,
  started_at TIMESTAMPTZ NOT NULL,
  settled_at TIMESTAMPTZ,
  PRIMARY KEY (run_id, turn_id, tool_call_id)
);

CREATE INDEX IF NOT EXISTS run_tool_attempts_run_time_idx
  ON run_tool_attempts (run_id, started_at);
