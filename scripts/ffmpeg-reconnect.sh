#!/bin/sh

set -u

child=''

stop_child() {
  if [ -n "$child" ]; then
    kill -TERM "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  exit 0
}

trap stop_child TERM INT

while true; do
  ffmpeg "$@" &
  child=$!
  wait "$child"
  exit_code=$?
  child=''
  echo "FFmpeg exited with code $exit_code; reconnecting in ${RECONNECT_DELAY:-1}s." >&2
  sleep "${RECONNECT_DELAY:-1}"
done
