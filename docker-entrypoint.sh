#!/bin/sh
set -eu

KIWIBNC_HOME="${KIWIBNC_HOME:-/root}"
KIWIBNC_DATA_DIR="${KIWIBNC_DATA_DIR:-/data}"
KIWIBNC_PROFILE_LINK="${KIWIBNC_HOME}/.kiwibnc"

mkdir -p "${KIWIBNC_HOME}" "${KIWIBNC_DATA_DIR}"

if [ -L "${KIWIBNC_PROFILE_LINK}" ]; then
  :
elif [ -e "${KIWIBNC_PROFILE_LINK}" ]; then
  echo "Existing path is not a symlink: ${KIWIBNC_PROFILE_LINK}" >&2
  exit 1
else
  ln -s "${KIWIBNC_DATA_DIR}" "${KIWIBNC_PROFILE_LINK}"
fi

exec "$@"
