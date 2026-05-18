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

  test('patches persisted config to load offline messaging before launching app', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiwibnc-entrypoint-'));
    const dataDir = path.join(tmpDir, 'data');
    const configDir = path.join(dataDir, '.kiwibnc');
    const configPath = path.join(configDir, 'config.ini');

    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      configPath,
      [
        '[extensions]',
        'loaded = [',
        '    "bouncer",',
        '    "webchat",',
        ']',
        '',
      ].join('\n')
    );

    const result = spawnSync(
      '/bin/sh',
      [
        'docker-entrypoint.sh',
        'sh',
        '-c',
        'grep -q \'"offline-messaging"\' "$KIWIBNC_DATA_DIR/.kiwibnc/config.ini"',
      ],
      {
        cwd: path.resolve(__dirname, '..', '..'),
        env: {
          ...process.env,
          KIWIBNC_DATA_DIR: dataDir,
        },
      }
    );

    expect(result.status).toBe(0);
  });

  test('preserves valid config when persisted loaded array has no trailing comma', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiwibnc-entrypoint-'));
    const dataDir = path.join(tmpDir, 'data');
    const configDir = path.join(dataDir, '.kiwibnc');
    const configPath = path.join(configDir, 'config.ini');

    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      configPath,
      [
        '[extensions]',
        'loaded = [',
        '    "bouncer"',
        ']',
        '',
      ].join('\n')
    );

    const result = spawnSync(
      '/bin/sh',
      [
        'docker-entrypoint.sh',
        'node',
        '-e',
        'const fs=require("fs"); const s=fs.readFileSync(process.env.KIWIBNC_DATA_DIR+"/.kiwibnc/config.ini","utf8"); process.exit(s.includes(\'"bouncer",\\n    "offline-messaging",\') ? 0 : 1)',
      ],
      {
        cwd: path.resolve(__dirname, '..', '..'),
        env: {
          ...process.env,
          KIWIBNC_DATA_DIR: dataDir,
        },
      }
    );

    expect(result.status).toBe(0);
  });

  test('preserves valid config when persisted loaded array is inline', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiwibnc-entrypoint-'));
    const dataDir = path.join(tmpDir, 'data');
    const configDir = path.join(dataDir, '.kiwibnc');
    const configPath = path.join(configDir, 'config.ini');

    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, '[extensions]\nloaded = ["bouncer"]\n');

    const result = spawnSync(
      '/bin/sh',
      [
        'docker-entrypoint.sh',
        'node',
        '-e',
        'const fs=require("fs"); const s=fs.readFileSync(process.env.KIWIBNC_DATA_DIR+"/.kiwibnc/config.ini","utf8"); process.exit(s.includes(\'loaded = ["bouncer",\\n    "offline-messaging",\') ? 0 : 1)',
      ],
      {
        cwd: path.resolve(__dirname, '..', '..'),
        env: {
          ...process.env,
          KIWIBNC_DATA_DIR: dataDir,
        },
      }
    );

    expect(result.status).toBe(0);
  });

  test('does not duplicate offline messaging in persisted config', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiwibnc-entrypoint-'));
    const dataDir = path.join(tmpDir, 'data');
    const configDir = path.join(dataDir, '.kiwibnc');
    const configPath = path.join(configDir, 'config.ini');

    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      configPath,
      [
        '[extensions]',
        'loaded = [',
        '    "bouncer",',
        '    "offline-messaging",',
        ']',
        '',
      ].join('\n')
    );

    const result = spawnSync(
      '/bin/sh',
      [
        'docker-entrypoint.sh',
        'sh',
        '-c',
        'test "$(grep -c \'"offline-messaging"\' "$KIWIBNC_DATA_DIR/.kiwibnc/config.ini")" = 1',
      ],
      {
        cwd: path.resolve(__dirname, '..', '..'),
        env: {
          ...process.env,
          KIWIBNC_DATA_DIR: dataDir,
        },
      }
    );

    expect(result.status).toBe(0);
  });

  test('adds an extensions section when persisted config lacks one', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiwibnc-entrypoint-'));
    const dataDir = path.join(tmpDir, 'data');
    const configDir = path.join(dataDir, '.kiwibnc');
    const configPath = path.join(configDir, 'config.ini');

    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, '[log]\nlevel="info"\n');

    const result = spawnSync(
      '/bin/sh',
      [
        'docker-entrypoint.sh',
        'sh',
        '-c',
        'grep -q "^\\[extensions\\]$" "$KIWIBNC_DATA_DIR/.kiwibnc/config.ini" && grep -q \'"offline-messaging"\' "$KIWIBNC_DATA_DIR/.kiwibnc/config.ini"',
      ],
      {
        cwd: path.resolve(__dirname, '..', '..'),
        env: {
          ...process.env,
          KIWIBNC_DATA_DIR: dataDir,
        },
      }
    );

    expect(result.status).toBe(0);
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
