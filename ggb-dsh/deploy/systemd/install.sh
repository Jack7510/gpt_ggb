#!/bin/sh
# Install the reviewed V3 Node/systemd units. Run as root on the target host.
# The deployment environment and 0600 secret files must already exist under
# /etc/ggb-dsh; this script neither generates nor prints secrets.
set -eu

root_dir=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)
test -r /etc/ggb-dsh/server.env || { echo 'missing /etc/ggb-dsh/server.env' >&2; exit 1; }
test -r /etc/ggb-dsh/secrets/server-pepper || { echo 'missing server-pepper secret file' >&2; exit 1; }
test -r /etc/ggb-dsh/secrets/worker-secret || { echo 'missing worker-secret secret file' >&2; exit 1; }

install -m 0644 "$root_dir/ggb-dsh-worker.service" /etc/systemd/system/ggb-dsh-worker.service
install -m 0644 "$root_dir/ggb-dsh-api.service" /etc/systemd/system/ggb-dsh-api.service
systemctl daemon-reload
systemctl enable ggb-dsh-worker.service ggb-dsh-api.service
