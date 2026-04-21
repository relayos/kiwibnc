#!/bin/sh
set -eu

KIWIBNC_DATA_DIR="${KIWIBNC_DATA_DIR:-/data}"

mkdir -p "${KIWIBNC_DATA_DIR}"
export HOME="${KIWIBNC_DATA_DIR}"

exec "$@"
