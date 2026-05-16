'use strict';

const Database = require('../../src/libs/database');

function createConfig(database) {
    return {
        get(key, def) {
            if (key === 'database') {
                return database;
            }
            return def;
        },
        relativePath(filePath) {
            return filePath;
        },
    };
}

describe('database configuration', () => {
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
});
