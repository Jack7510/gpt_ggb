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
# Debug only. GGB_V3_DSH_TRACE=1 records every model request and raw answer under .local/dsh-trace and
# keeps the per-run DSH homes instead of deleting them. Unset leaves the shipped behaviour untouched.
# Set GGB_V3_DSH_TRACE_ROOT directly to choose another location. Never enable this in production.
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

mkdir -p .local/dsh-home

if [ "$watch" = "1" ]; then
  # `node --watch` restarts through SIGTERM and the API drains for
  # GGB_V3_DRAIN_GRACE_MS before releasing the API port. Zero keeps a reload at the cost of the
  # rebuild instead of adding the production drain window to every edit.
  : "${GGB_V3_DRAIN_GRACE_MS:=0}"
  export GGB_V3_DRAIN_GRACE_MS
fi

# Build once up front: the first `tsc -b --watch` build is asynchronous and would
# otherwise race the processes that load `lib/`.
pnpm exec tsc -b

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
  pnpm exec tsc -b --watch --preserveWatchOutput &
  tsc_pid=$!
  node --watch apps/worker/lib/main.js &
  worker_pid=$!
  node --watch apps/api/lib/main.js &
  api_pid=$!
else
  node apps/worker/lib/main.js &
  worker_pid=$!
  node apps/api/lib/main.js &
  api_pid=$!
fi

wait "$api_pid"
