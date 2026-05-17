'use strict';

jest.mock('bcrypt', () => ({
    compare: jest.fn(),
}));

const Users = require('../../src/worker/users');
const DatabaseSavable = require('../../src/libs/dataModels/databasesavable');

describe('worker users', () => {
    let originalConfig;

    beforeEach(() => {
        originalConfig = global.config;
        global.config = {
            get: jest.fn(() => -1),
        };
    });

    afterEach(() => {
        global.config = originalConfig;
    });

    test('addNetwork persists channels', async () => {
        const saved = [];
        const db = {
            factories: {
                Network: jest.fn(() => ({
                    save: jest.fn(function save() {
                        saved.push(this);
                    }),
                })),
            },
        };
        const users = new Users(db);

        const network = await users.addNetwork(42, {
            name: 'ExampleNet',
            host: 'irc.example.test',
            port: 6667,
            tls: false,
            nick: 'testuser',
            username: 'testuser',
            realname: 'testuser',
            channels: '#lobby,#help',
        });

        expect(network.channels).toBe('#lobby,#help');
        expect(saved).toHaveLength(1);
        expect(saved[0].channels).toBe('#lobby,#help');
    });

    test('addUser persists core user fields only', async () => {
        const saved = [];
        const db = {
            factories: {
                User: jest.fn(() => ({
                    save: jest.fn(function save() {
                        saved.push(this);
                    }),
                })),
            },
        };
        const users = new Users(db);

        await users.addUser('testuser', 'secret', false);

        expect(saved).toHaveLength(1);
        expect(saved[0].username).toBe('testuser');
        expect(saved[0].admin).toBeUndefined();
    });
});

describe('database savable models', () => {
    class TestSavable extends DatabaseSavable {}
    TestSavable.table = 'users';

    function createInsertDb(client, insertResult, returningResult = [{ id: 777 }]) {
        const returning = jest.fn().mockResolvedValue(returningResult);
        const insertQuery = Promise.resolve(insertResult);
        insertQuery.returning = returning;
        const insert = jest.fn(() => insertQuery);
        const dbUsers = jest.fn(() => ({ insert }));
        dbUsers.client = { config: { client } };

        return {
            db: { dbUsers },
            insert,
            returning,
        };
    }

    test('normalizes inserted ids returned by sqlite and other knex clients', () => {
        expect(DatabaseSavable.normalizeInsertedId([{ id: 5230 }])).toBe(5230);
        expect(DatabaseSavable.normalizeInsertedId([5230])).toBe(5230);
        expect(DatabaseSavable.normalizeInsertedId(5230)).toBe(5230);
    });

    test('does not call returning for mysql inserts', async () => {
        const { db, insert, returning } = createInsertDb('mysql', [5230]);
        const model = new TestSavable(db);

        model.setData('username', 'testuser');
        await model.save();

        expect(insert).toHaveBeenCalledWith({ username: 'testuser' });
        expect(returning).not.toHaveBeenCalled();
        expect(model.getData('id')).toBe(5230);
    });

    test('keeps returning for clients that support insert returning ids', async () => {
        const { db, returning } = createInsertDb('pg', [999], [{ id: 5230 }]);
        const model = new TestSavable(db);

        model.setData('username', 'testuser');
        await model.save();

        expect(returning).toHaveBeenCalledWith('id');
        expect(model.getData('id')).toBe(5230);
    });
});
