#!/bin/sh
set -eu

KIWIBNC_DATA_DIR="${KIWIBNC_DATA_DIR:-/data}"

mkdir -p "${KIWIBNC_DATA_DIR}"
export HOME="${KIWIBNC_DATA_DIR}"

"$@" &
app_pid=$!

forward_signal() {
  kill -TERM "${app_pid}" 2>/dev/null || true
  wait "${app_pid}" 2>/dev/null || true
  exit 143
}

trap forward_signal TERM INT HUP

wait "${app_pid}"
