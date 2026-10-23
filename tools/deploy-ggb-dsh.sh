#!/bin/sh
# Local source deployment. See --help; this does not publish a release.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$HERE/deploy-ggb-dsh.mjs" "$@"
