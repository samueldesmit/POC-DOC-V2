#!/bin/sh
set -eu
# Railway mounts the persistent volume as root at runtime.
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data
  chown node:node /data
  exec gosu node "$@"
fi
exec "$@"
