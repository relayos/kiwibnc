const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

describe('docker-entrypoint', () => {
  test('runs KiwiBNC with HOME set to the persisted data directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiwibnc-entrypoint-'));
    const homeDir = path.join(tmpDir, 'home');
    const dataDir = path.join(tmpDir, 'data');

    fs.mkdirSync(homeDir, { recursive: true });

    const result = spawnSync(
      '/bin/sh',
      [
        'docker-entrypoint.sh',
        'sh',
        '-c',
        'test "$HOME" = "$KIWIBNC_DATA_DIR" && test ! -e "$KIWIBNC_HOME/.kiwibnc"',
      ],
      {
        cwd: path.resolve(__dirname, '..', '..'),
        env: {
          ...process.env,
          KIWIBNC_HOME: homeDir,
          KIWIBNC_DATA_DIR: dataDir,
        },
      }
    );

    expect(result.status).toBe(0);
  });

  test('starts the admin seed helper once when seed JSON is present', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiwibnc-entrypoint-'));
    const binDir = path.join(tmpDir, 'bin');
    const markerFile = path.join(tmpDir, 'seed-helper-args.json');

    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      path.join(binDir, 'node'),
      [
        '#!/bin/sh',
        'printf "%s\\n" "$@" > "$NODE_ARGS_FILE"',
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );

    const result = spawnSync(
      '/bin/sh',
      [
        'docker-entrypoint.sh',
        '/bin/sh',
        '-c',
        'test "$HOME" = "$KIWIBNC_DATA_DIR"',
      ],
      {
        cwd: path.resolve(__dirname, '..', '..'),
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          KIWIBNC_DATA_DIR: path.join(tmpDir, 'data'),
          NODE_ARGS_FILE: markerFile,
          RELAYOS_KIWIBNC_ADMIN_JSON: JSON.stringify({
            username: 'admin',
            password: 'secret',
            network_name: 'KiwiNet',
            irc_host: 'irc.example.org',
            irc_port: '6697',
            irc_tls: 'true',
          }),
        },
      }
    );

    expect(result.status).toBe(0);
    expect(fs.readFileSync(markerFile, 'utf8').trim().split('\n')).toEqual([
      '/app/scripts/seed-admin.js',
    ]);
  });

  test('fails startup when seeded-admin mode is enabled and the helper fails', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiwibnc-entrypoint-'));
    const binDir = path.join(tmpDir, 'bin');

    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      path.join(binDir, 'node'),
      [
        '#!/bin/sh',
        'exit 1',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );

    const result = spawnSync(
      '/bin/sh',
      [
        'docker-entrypoint.sh',
        '/bin/sh',
        '-c',
        'sleep 10',
      ],
      {
        cwd: path.resolve(__dirname, '..', '..'),
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          KIWIBNC_DATA_DIR: path.join(tmpDir, 'data'),
          RELAYOS_KIWIBNC_ADMIN_JSON: JSON.stringify({
            username: 'admin',
            password: 'secret',
            network_name: 'KiwiNet',
            irc_host: 'irc.example.org',
            irc_port: '6697',
            irc_tls: 'true',
          }),
        },
      }
    );

    expect(result.status).toBe(1);
  });

  test('forwards termination signals to the supervised app process', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiwibnc-entrypoint-'));
    const binDir = path.join(tmpDir, 'bin');
    const appPidFile = path.join(tmpDir, 'app.pid');

    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      path.join(binDir, 'node'),
      [
        '#!/bin/sh',
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );

    const child = spawn(
      '/bin/sh',
      [
        'docker-entrypoint.sh',
        '/bin/sh',
        '-c',
        'echo "$$" > "$APP_PID_FILE"; trap "exit 0" TERM INT; while :; do sleep 1; done',
      ],
      {
        cwd: path.resolve(__dirname, '..', '..'),
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          KIWIBNC_DATA_DIR: path.join(tmpDir, 'data'),
          APP_PID_FILE: appPidFile,
          RELAYOS_KIWIBNC_ADMIN_JSON: JSON.stringify({
            username: 'admin',
            password: 'secret',
            network_name: 'KiwiNet',
            irc_host: 'irc.example.org',
            irc_port: '6697',
            irc_tls: 'true',
          }),
        },
        stdio: 'ignore',
      }
    );

    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      (function poll() {
        if (fs.existsSync(appPidFile)) {
          resolve();
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error('timed out waiting for app pid file'));
          return;
        }
        setTimeout(poll, 50);
      })();
    });

    const appPid = Number(fs.readFileSync(appPidFile, 'utf8').trim());
    child.kill('SIGTERM');

    await new Promise((resolve, reject) => {
      child.on('exit', (code, signal) => resolve({ code, signal }));
      child.on('error', reject);
    });

    let appAlive = true;
    try {
      process.kill(appPid, 0);
    } catch (err) {
      if (err.code === 'ESRCH') {
        appAlive = false;
      } else {
        throw err;
      }
    }

    expect(appAlive).toBe(false);
  });
});
