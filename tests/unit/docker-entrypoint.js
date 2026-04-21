const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

describe('docker-entrypoint', () => {
  test('links the persisted data directory to the default KiwiBNC home profile path', () => {
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
        'test -L "$KIWIBNC_HOME/.kiwibnc" && test "$(readlink "$KIWIBNC_HOME/.kiwibnc")" = "$KIWIBNC_DATA_DIR"',
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
});
