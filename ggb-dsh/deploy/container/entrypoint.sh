#!/bin/sh
# Starts the API and/or the Worker process of the single-image plugin-core Server (§7.5).
#
#   entrypoint.sh api     # HTTP/SSE, plugin-core runs, static PWA and health
#   entrypoint.sh worker  # execute plugin-core turns against the DSH runner
#   entrypoint.sh both    # one container running both (first-version topology)
#
# Secrets are injected as 0600 files and read through the `<NAME>_FILE` variables that
# `apps/api/src/config/env.ts` and `apps/worker/src/config/env.ts` already support, so
# they never appear in `docker inspect` or the process environment.
set -eu

: "${GGB_V3_SERVER_PEPPER_FILE:=/run/ggb/server-pepper}"
: "${GGB_V3_WORKER_SECRET_FILE:=/run/ggb/worker-secret}"
: "${GGB_V3_WORKER_SOCKET_PATH:=/run/ggb/worker.sock}"
: "${GGB_V3_DSH_HOME_ROOT:=/dsh-home}"
export GGB_V3_SERVER_PEPPER_FILE GGB_V3_WORKER_SECRET_FILE
export GGB_V3_WORKER_SOCKET_PATH GGB_V3_DSH_HOME_ROOT

for secret in "$GGB_V3_SERVER_PEPPER_FILE" "$GGB_V3_WORKER_SECRET_FILE"; do
  if [ ! -r "$secret" ]; then
    echo "missing secret file: $secret" >&2
    exit 1
  fi
done

role="${1:-both}"
api_pid=''
worker_pid=''

# §15: release and scale-in stop admission first, let the worker mark itself draining,
# finish or cancel within a bounded time, then close Harness/socket/credential/DB.
shutdown() {
  trap '' TERM INT
  [ -n "$api_pid" ] && kill -TERM "$api_pid" 2>/dev/null || true
  [ -n "$worker_pid" ] && kill -TERM "$worker_pid" 2>/dev/null || true
  wait
}

start_worker() {
  node apps/worker/lib/main.js &
  worker_pid=$!
}

start_api() {
  node apps/api/lib/main.js &
  api_pid=$!
}

trap shutdown TERM INT

case "$role" in
  api) start_api; wait "$api_pid" ;;
  worker) start_worker; wait "$worker_pid" ;;
  both)
    start_worker
    start_api
    wait "$api_pid"
    ;;
  *)
    echo "unknown role: $role (expected api, worker or both)" >&2
    exit 64
    ;;
esac
