#!/bin/sh
set -eu

KIWIBNC_DATA_DIR="${KIWIBNC_DATA_DIR:-/data}"

mkdir -p "${KIWIBNC_DATA_DIR}"
export HOME="${KIWIBNC_DATA_DIR}"

patch_offline_messaging_extension() {
  config_file="${KIWIBNC_DATA_DIR}/.kiwibnc/config.ini"

  if [ ! -f "${config_file}" ]; then
    return 0
  fi

  if grep -F '"offline-messaging"' "${config_file}" >/dev/null 2>&1; then
    return 0
  fi

  node - "${config_file}" <<'NODE'
const fs = require('fs');

const configPath = process.argv[2];
let config = fs.readFileSync(configPath, 'utf8');

config = config.replace(
  /(\[extensions\][\s\S]*?loaded\s*=\s*\[)([\s\S]*?)(\])/m,
  (match, start, loaded, end) => {
    if (loaded.includes('"offline-messaging"')) {
      return match;
    }

    const separator = loaded.endsWith('\n') ? '' : '\n';
    return `${start}${loaded}${separator}    "offline-messaging",\n${end}`;
  }
);

fs.writeFileSync(configPath, config);
NODE
}

patch_offline_messaging_extension

"$@" &
app_pid=$!

forward_signal() {
  kill -TERM "${app_pid}" 2>/dev/null || true
  wait "${app_pid}" 2>/dev/null || true
  exit 143
}

trap forward_signal TERM INT HUP

wait "${app_pid}"
