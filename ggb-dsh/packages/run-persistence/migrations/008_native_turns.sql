-- One Harness session per claimed lease epoch; its budget count is in native_checkpoint.
CREATE TABLE IF NOT EXISTS run_native_turns (
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  turn_id UUID NOT NULL,
  lease_epoch INTEGER NOT NULL CHECK (lease_epoch > 0),
  model_id TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started','closed')),
  closed_at TIMESTAMPTZ,
  PRIMARY KEY (run_id, turn_id),
  UNIQUE (run_id, lease_epoch),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);
