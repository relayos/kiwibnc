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
const extensionLine = '    "offline-messaging",';

function patchExtensionsSection(text) {
  const sectionStart = text.search(/^\[extensions\]$/m);
  if (sectionStart === -1) {
    const separator = text.endsWith('\n') ? '\n' : '\n\n';
    return `${text}${separator}[extensions]\nloaded = [\n${extensionLine}\n]\n`;
  }

  const nextSectionMatch = text.slice(sectionStart + 1).match(/\n\[[^\]\n]+\]/);
  const sectionEnd = nextSectionMatch
    ? sectionStart + 1 + nextSectionMatch.index
    : text.length;
  let section = text.slice(sectionStart, sectionEnd);

  if (!/loaded\s*=\s*\[/.test(section)) {
    const separator = section.endsWith('\n') ? '' : '\n';
    section = `${section}${separator}loaded = [\n${extensionLine}\n]\n`;
  } else {
    section = section.replace(
      /(loaded\s*=\s*\[)([\s\S]*?)(\])/m,
      (match, start, loaded, end) => {
        if (loaded.includes('"offline-messaging"')) {
          return match;
        }

        const separator = loaded.endsWith('\n') ? '' : '\n';
        return `${start}${loaded}${separator}${extensionLine}\n${end}`;
      }
    );
  }

  return `${text.slice(0, sectionStart)}${section}${text.slice(sectionEnd)}`;
}

config = patchExtensionsSection(config);

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
