-- The settled canvas projection the model actually received for one ggb_apply.
-- The attempt's status/result keep the registration-time outcome (`waiting_for_canvas`), because
-- that first commit is what publishes `execution.apply`. This additive column records what the run
-- later observed, so an audit can tell "registered" from "what the model saw" without relaxing the
-- once-settled attempt immutability that keeps tool replays idempotent. NULL for every other tool
-- and for attempts recorded before this column existed.
ALTER TABLE run_tool_attempts ADD COLUMN IF NOT EXISTS settlement JSONB;
