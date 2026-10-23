#!/bin/sh
# Start the local backend against the current ggb-plugins source build.
# The pinned vendor install is copied, compiled/skill files are overlaid, and
# the release lock is restored as soon as the Worker has loaded the test root.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$HERE/.." && pwd)
PLUGIN=$(CDPATH= cd -- "$ROOT/../ggb-plugins" && pwd)
LOCK="$ROOT/vendor/plugin-core.lock.json"
BACKUP="$ROOT/.tmp/plugin-core.lock.json.verify-backup"
TEST_ROOT="$ROOT/.tmp/plugin-manual"

cd "$PLUGIN"
pnpm build

cd "$ROOT"
PINNED=$(node -p "require('./vendor/plugin-core.lock.json').archiveSha256")
PINNED_ROOT="$ROOT/.plugin-core-runtime/$PINNED"
test -d "$PINNED_ROOT" || {
  echo "missing pinned install: $PINNED_ROOT" >&2
  echo "run: pnpm run provision:plugin-core" >&2
  exit 1
}

rm -rf "$TEST_ROOT"
cp -a "$PINNED_ROOT" "$TEST_ROOT"
cp -R "$PLUGIN/dist/." "$TEST_ROOT/dist/"
cp -R "$PLUGIN/dsh/." "$TEST_ROOT/dsh/"
cp -R "$PLUGIN/skills/ggb-construction/." "$TEST_ROOT/skills/ggb-construction/"
cp "$PLUGIN/capabilities.json" "$TEST_ROOT/capabilities.json"

mkdir -p "$ROOT/.tmp"
cp "$LOCK" "$BACKUP"
dev_pid=
restored=0
restore_lock() {
  if [ "$restored" = 0 ] && [ -f "$BACKUP" ]; then
    cp "$BACKUP" "$LOCK"
    rm -f "$BACKUP"
    restored=1
  fi
}
cleanup() {
  restore_lock
  if [ -n "${dev_pid:-}" ]; then
    kill -TERM "$dev_pid" 2>/dev/null || true
    wait "$dev_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

node --input-type=module - "$LOCK" "$TEST_ROOT" <<'NODE'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const [lockPath, root] = process.argv.slice(2)
const lock = JSON.parse(await readFile(lockPath, 'utf8'))
for (const ref of Object.keys(lock.files)) {
  lock.files[ref] = createHash('sha256')
    .update(await readFile(join(root, ref))).digest('hex')
}
lock.archiveSha256 = createHash('sha256')
  .update(JSON.stringify(lock.files)).digest('hex')
await writeFile(lockPath, JSON.stringify(lock, null, 2) + '\n')
NODE

echo "plugin test root: $TEST_ROOT"
GGB_PLUGIN_ROOT="$TEST_ROOT" GGB_V3_WATCH=0 sh deploy/local/dev.sh &
dev_pid=$!

ready=0
i=0
while [ "$i" -lt 120 ]; do
  if curl -fsS "http://127.0.0.1:${PORT:-8081}/api/v3/health/ready" >/dev/null 2>&1; then
    ready=1
    break
  fi
  kill -0 "$dev_pid" 2>/dev/null || break
  i=$((i + 1))
  sleep 1
done
if [ "$ready" != 1 ]; then
  echo "backend did not become ready" >&2
  exit 1
fi
restore_lock
echo "backend ready on http://127.0.0.1:${PORT:-8081}; release lock restored"
wait "$dev_pid"
