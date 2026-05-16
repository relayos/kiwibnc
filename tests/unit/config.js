'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Config = require('../../src/libs/config');

describe('config environment overrides', () => {
    const envKeys = [
        'BNC_DATABASE_CRYPT_KEY',
        'BNC_DATABASE_USERS',
        'BNC_DATABASE_TABLE_PREFIX',
    ];
    let originalEnv;

    beforeEach(() => {
        originalEnv = {};
        envKeys.forEach((key) => {
            originalEnv[key] = process.env[key];
            delete process.env[key];
        });
    });

    afterEach(() => {
        envKeys.forEach((key) => {
            if (typeof originalEnv[key] === 'undefined') {
                delete process.env[key];
            } else {
                process.env[key] = originalEnv[key];
            }
        });
    });

    test('applies nested BNC environment overrides to direct scalar reads', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiwibnc-config-'));
        const configPath = path.join(tmpDir, 'config.ini');
        fs.writeFileSync(configPath, [
            '[database]',
            'users="./users.db"',
            'crypt_key="local-crypt-key"',
            'table_prefix=""',
            '',
        ].join('\n'));

        process.env.BNC_DATABASE_CRYPT_KEY = '12345678901234567890123456789012';
        process.env.BNC_DATABASE_USERS = 'mysql://kiwibnc:secret@db.example:3306/wordpress';
        process.env.BNC_DATABASE_TABLE_PREFIX = 'bnc_';

        const config = new Config(configPath);
        config.load();

        expect(config.get('database.crypt_key')).toBe('12345678901234567890123456789012');
        expect(config.get('database').users).toBe('mysql://kiwibnc:secret@db.example:3306/wordpress');
        expect(config.get('database').table_prefix).toBe('bnc_');
    });
});
