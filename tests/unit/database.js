'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('../../src/libs/database');
const Config = require('../../src/libs/config');

function createConfig(database, baseDir = '') {
    return {
        get(key, def) {
            if (key === 'database') {
                return database;
            }
            return def;
        },
        relativePath(filePath) {
            if (filePath[0] === '/') {
                return filePath;
            }
            return path.join(baseDir, filePath);
        },
    };
}

describe('database configuration', () => {
    let tmpDirs = [];
    let originalUsersEnv;
    let warnSpy;

    beforeEach(() => {
        originalUsersEnv = process.env.BNC_DATABASE_USERS;
        delete process.env.BNC_DATABASE_USERS;
        warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        warnSpy.mockRestore();

        if (typeof originalUsersEnv === 'undefined') {
            delete process.env.BNC_DATABASE_USERS;
        } else {
            process.env.BNC_DATABASE_USERS = originalUsersEnv;
        }

        tmpDirs.forEach((tmpDir) => {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });
        tmpDirs = [];
    });

    function makeTmpDir() {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiwibnc-db-'));
        tmpDirs.push(tmpDir);
        return tmpDir;
    }

    async function closeDb(db) {
        await db.dbUsers.destroy();
        await db.dbConnections.destroy();
    }

    function retiredUsersFiles(tmpDir) {
        return fs.readdirSync(tmpDir)
            .filter((filename) => filename.startsWith('users.db.retired-') && filename.endsWith('.bak'));
    }

    test('prefixes KiwiBNC user tables when configured', () => {
        const db = new Database(createConfig({
            users: 'mysql://kiwibnc:secret@db.example:3306/wordpress',
            table_prefix: 'bnc_',
        }));

        const selectSql = db.dbUsers('users').select('*').toSQL().sql;
        const joinSql = db.dbUsers('user_networks')
            .innerJoin('users', 'users.id', 'user_networks.user_id')
            .innerJoin('user_tokens', 'user_tokens.user_id', 'user_networks.user_id')
            .select('user_networks.*', 'users.password as _pass')
            .toSQL()
            .sql;

        expect(selectSql).toContain('`bnc_users`');
        expect(joinSql).toContain('`bnc_user_networks`');
        expect(joinSql).toContain('`bnc_users`');
        expect(joinSql).toContain('`bnc_user_tokens`');
        expect(joinSql).not.toContain('`user_networks`');
        expect(joinSql).not.toContain('`users`');
        expect(joinSql).not.toContain('`user_tokens`');
    });

    test('prefixes user migration metadata table in shared databases', () => {
        const db = new Database(createConfig({
            state: 'connections.db',
            users: 'users.db',
            table_prefix: 'bnc_',
        }));

        expect(db.userMigrationTableName).toBe('bnc_knex_migrations');
    });

    test('parses mysql user dsn with raw slash password', () => {
        const db = new Database(createConfig({
            users: 'mysql://kiwibnc:raw/pass@db.example:3307/wordpress',
            table_prefix: 'bnc_',
        }));

        const connection = db.dbUsers.client.config.connection;
        expect(connection.host).toBe('db.example');
        expect(connection.port).toBe(3307);
        expect(connection.user).toBe('kiwibnc');
        expect(connection.password).toBe('raw/pass');
        expect(connection.database).toBe('wordpress');
    });

    test('archives existing stale users.db when users database is mysql', async () => {
        const tmpDir = makeTmpDir();
        const usersDb = path.join(tmpDir, 'users.db');
        fs.writeFileSync(usersDb, 'stale user data');

        const db = new Database(createConfig({
            users: 'mysql://kiwibnc:secret@db.example:3306/wordpress',
        }, tmpDir));
        await closeDb(db);

        const archived = retiredUsersFiles(tmpDir);
        expect(fs.existsSync(usersDb)).toBe(false);
        expect(archived).toHaveLength(1);
        expect(fs.readFileSync(path.join(tmpDir, archived[0]), 'utf8')).toBe('stale user data');
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Retired stale SQLite users database'));
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('database.users is configured for MySQL/MariaDB'));
    });

    test('does not fail when stale users.db is missing for mysql users database', async () => {
        const tmpDir = makeTmpDir();

        const db = new Database(createConfig({
            users: 'mysql://kiwibnc:secret@db.example:3306/wordpress',
        }, tmpDir));
        await closeDb(db);

        expect(retiredUsersFiles(tmpDir)).toHaveLength(0);
        expect(warnSpy).not.toHaveBeenCalled();
    });

    test('leaves users.db untouched when users database is sqlite', async () => {
        const tmpDir = makeTmpDir();
        const usersDb = path.join(tmpDir, 'users.db');
        fs.writeFileSync(usersDb, 'active sqlite user data');

        const db = new Database(createConfig({
            users: './users.db',
        }, tmpDir));
        await closeDb(db);

        expect(fs.existsSync(usersDb)).toBe(true);
        expect(fs.readFileSync(usersDb, 'utf8')).toBe('active sqlite user data');
        expect(retiredUsersFiles(tmpDir)).toHaveLength(0);
        expect(warnSpy).not.toHaveBeenCalled();
    });

    test('archives stale users.db when env override changes config from sqlite to mysql', async () => {
        const tmpDir = makeTmpDir();
        const configPath = path.join(tmpDir, 'config.ini');
        const usersDb = path.join(tmpDir, 'users.db');
        fs.writeFileSync(configPath, [
            '[database]',
            'users="./users.db"',
            '',
        ].join('\n'));
        fs.writeFileSync(usersDb, 'env overridden sqlite user data');
        process.env.BNC_DATABASE_USERS = 'mysql://kiwibnc:secret@db.example:3306/wordpress';

        const config = new Config(configPath);
        config.load();
        const db = new Database(config);
        await closeDb(db);

        const archived = retiredUsersFiles(tmpDir);
        expect(fs.existsSync(usersDb)).toBe(false);
        expect(archived).toHaveLength(1);
        expect(fs.readFileSync(path.join(tmpDir, archived[0]), 'utf8')).toBe('env overridden sqlite user data');
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Retired stale SQLite users database'));
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('database.users is configured for MySQL/MariaDB'));
    });
});
