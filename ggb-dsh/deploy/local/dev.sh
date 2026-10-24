#!/bin/sh
# Local two-process run of the plugin-core Server without containers.
#
#   sh deploy/local/dev.sh
#
# API and Worker are independent processes and must share one run store. PostgreSQL is
# production; local development defaults to the node:sqlite adapter. Memory stores are
# deliberately process-local and are only valid in unit tests.
#
# Watch mode is on by default: `tsc -b --watch` keeps `lib/` current and `node --watch`
# restarts API/Worker on each rebuild, so editing a source file reloads without a manual
# restart. Set GGB_V3_WATCH=0 for a one-shot start.
set -eu
umask 077

cd "$(dirname "$0")/../.."

watch="${GGB_V3_WATCH:-1}"
: "${PORT:=8081}"
export PORT
# PostgreSQL requires migrations 017 and 018 before startup. Run the migration job
# separately; this launcher does not run it.

: "${GGB_V3_SERVER_PEPPER:=$(openssl rand -hex 32)}"
: "${GGB_V3_WORKER_SECRET:=$(openssl rand -hex 32)}"
: "${GGB_V3_WORKER_SOCKET_PATH:=$(pwd)/.local/worker.sock}"
: "${GGB_PLUGIN_CORE_TOOL_SOCKET:=$(pwd)/.local/plugin-core-tool.sock}"
: "${GGB_V3_DSH_HOME_ROOT:=$(pwd)/.local/dsh-home}"
# Local process logs and bounded per-run diagnostics are always retained.
: "${GGB_V3_LOG_DIR:=$(pwd)/.local/logs/$(date -u +%Y%m%dT%H%M%SZ)-$$}"
: "${GGB_PLUGIN_CORE_OUTPUT_ROOT:=$(pwd)/.local/plugin-core-runs}"
# Debug only. Keep text-only DSH homes under this root; image-run homes are still deleted.
# This switch does not record raw model requests or answers. Never enable it in production.
if [ "${GGB_V3_DSH_TRACE:-0}" = "1" ]; then
  : "${GGB_V3_DSH_TRACE_ROOT:=$(pwd)/.local/dsh-trace}"
fi
: "${GGB_V3_SQLITE_PATH:=$(pwd)/.local/runs.sqlite}"
# plugin-core is the only engine.
: "${GGB_AGENT_ENGINE:=plugin_core}"
# The Worker resolves the hash-named installation from vendor/plugin-core.lock.json.
# GGB_PLUGIN_ROOT can select another complete installation of that same release.
# Vite's default local URL is http://localhost:5173. Keep the API CORS origin
# aligned with it; a mismatch is intentionally reported as "unknown endpoint".
: "${GGB_V3_ALLOWED_ORIGIN:=http://localhost:5173}"
export GGB_AGENT_ENGINE GGB_PLUGIN_ROOT
export GGB_V3_SERVER_PEPPER GGB_V3_WORKER_SECRET
export GGB_V3_WORKER_SOCKET_PATH GGB_PLUGIN_CORE_TOOL_SOCKET
export GGB_V3_DSH_HOME_ROOT GGB_V3_ALLOWED_ORIGIN GGB_V3_SQLITE_PATH GGB_V3_DSH_TRACE_ROOT
export GGB_PLUGIN_CORE_OUTPUT_ROOT

mkdir -p "$GGB_V3_LOG_DIR" "$GGB_V3_DSH_HOME_ROOT" "$GGB_PLUGIN_CORE_OUTPUT_ROOT"
echo "[dev] process logs: $GGB_V3_LOG_DIR"
echo "[dev] run diagnostics: $GGB_PLUGIN_CORE_OUTPUT_ROOT/<runId>"

if [ "$watch" = "1" ]; then
  # `node --watch` restarts through SIGTERM and the API drains for
  # GGB_V3_DRAIN_GRACE_MS before releasing the API port. Zero keeps a reload at the cost of the
  # rebuild instead of adding the production drain window to every edit.
  : "${GGB_V3_DRAIN_GRACE_MS:=0}"
  export GGB_V3_DRAIN_GRACE_MS
fi

# Build once up front: the first `tsc -b --watch` build is asynchronous and would
# otherwise race the processes that load `lib/`.
if ! pnpm exec tsc -b > "$GGB_V3_LOG_DIR/build.log" 2>&1; then
  cat "$GGB_V3_LOG_DIR/build.log" >&2
  exit 1
fi

worker_pid=""
api_pid=""
tsc_pid=""

cleanup() {
  trap - EXIT TERM INT
  # `node --watch` forwards SIGTERM to the process it supervises, so signalling the
  # supervisors is enough; `tsc` needs its own signal.
  for pid in "$worker_pid" "$api_pid" "$tsc_pid"; do
    if [ -n "$pid" ]; then kill -TERM "$pid" 2>/dev/null || true; fi
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 0' TERM INT

if [ "$watch" = "1" ]; then
  pnpm exec tsc -b --watch --preserveWatchOutput > "$GGB_V3_LOG_DIR/tsc.log" 2>&1 &
  tsc_pid=$!
  node --watch apps/worker/lib/main.js >> "$GGB_V3_LOG_DIR/worker.log" 2>&1 &
  worker_pid=$!
  node --watch apps/api/lib/main.js >> "$GGB_V3_LOG_DIR/api.log" 2>&1 &
  api_pid=$!
else
  node apps/worker/lib/main.js >> "$GGB_V3_LOG_DIR/worker.log" 2>&1 &
  worker_pid=$!
  node apps/api/lib/main.js >> "$GGB_V3_LOG_DIR/api.log" 2>&1 &
  api_pid=$!
fi

wait "$api_pid"
