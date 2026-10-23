#!/usr/bin/env bash
# Thin shim: tools/q3-browser-fixture.mjs invokes the wrapper through `bash`.
set -euo pipefail
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/playwright-session-cli.mjs" "$@"
