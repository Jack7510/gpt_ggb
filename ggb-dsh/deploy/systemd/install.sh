#!/bin/sh
# Render reviewed units for this checkout; installation never starts the services.
# Usage: install.sh SERVICE_USER [--render OUTPUT_DIR | --check]
# NODE_BINARY can select an absolute Node executable before rendering.
set -eu

root_dir=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)
workspace=$(CDPATH='' cd -- "$root_dir/../.." && pwd)
service_user=${1:-${SUDO_USER:-}}
if [ -z "$service_user" ] || [ "$service_user" = root ]; then
  echo 'provide a non-root service user: install.sh SERVICE_USER [--render OUTPUT_DIR | --check]' >&2
  exit 64
fi
test "$(id -u "$service_user")" != 0 || { echo 'service user must not be root' >&2; exit 64; }
service_group=$(id -g "$service_user")
node_binary=${NODE_BINARY:-$(command -v node)}
# These values are inserted into systemd words and sed replacements, never shell code.
case "$workspace$node_binary$service_user$service_group" in
  *[!a-zA-Z0-9_./-]*) echo 'unit paths and account names must use letters, digits, _, ., / or -' >&2; exit 64 ;;
esac
case "$node_binary" in /*) ;; *) echo 'Node executable must be an absolute path' >&2; exit 64 ;; esac
test -x "$node_binary" || { echo 'missing Node executable' >&2; exit 1; }

if [ "${2:-}" = --render ] && [ "$#" = 3 ]; then
  destination=$3
  mkdir -p "$destination"
elif [ "$#" -le 1 ] || { [ "$#" = 2 ] && [ "$2" = --check ]; }; then
  test "$(id -u)" = 0 || { echo 'run installation as root; use --render for preview' >&2; exit 1; }
  "$node_binary" "$root_dir/preflight.mjs" --user "$workspace" "$service_user" /etc/ggb-dsh/server.env
  if [ "${2:-}" = --check ]; then exit 0; fi
  destination=$(mktemp -d)
  trap 'rm -rf "$destination"' EXIT
  trap 'exit 1' HUP INT TERM
else
  echo 'usage: install.sh SERVICE_USER [--render OUTPUT_DIR | --check]' >&2
  exit 64
fi

for role in api worker; do
  sed -e "s|@WORKSPACE@|$workspace|g" -e "s|@USER@|$service_user|g" \
    -e "s|@GROUP@|$service_group|g" -e "s|@NODE@|$node_binary|g" \
    "$root_dir/ggb-dsh-$role.service" > "$destination/ggb-dsh-$role.service"
done
if [ "${2:-}" = --render ]; then
  echo "rendered units: $destination"
  exit 0
fi
install -m 0644 "$destination/ggb-dsh-worker.service" /etc/systemd/system/ggb-dsh-worker.service
install -m 0644 "$destination/ggb-dsh-api.service" /etc/systemd/system/ggb-dsh-api.service
systemctl daemon-reload
systemctl enable ggb-dsh-worker.service ggb-dsh-api.service
