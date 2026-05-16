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
            name: 'RelayOS',
            host: 'inspircd',
            port: 6667,
            tls: false,
            nick: 'wpuser',
            username: 'wpuser',
            realname: 'wpuser',
            channels: '#lobby,#help',
        });

        expect(network.channels).toBe('#lobby,#help');
        expect(saved).toHaveLength(1);
        expect(saved[0].channels).toBe('#lobby,#help');
    });

    test('addUser persists wordpress user id when provided', async () => {
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

        await users.addUser('wpuser', 'secret', false, { wp_user_id: 5230 });

        expect(saved).toHaveLength(1);
        expect(saved[0].wp_user_id).toBe(5230);
    });

    test('setUserWordPressId updates existing users', async () => {
        const update = jest.fn();
        const where = jest.fn(() => ({ update }));
        const dbUsers = jest.fn(() => ({ where }));
        const users = new Users({ dbUsers });

        await users.setUserWordPressId(7, 5230);

        expect(dbUsers).toHaveBeenCalledWith('users');
        expect(where).toHaveBeenCalledWith('id', 7);
        expect(update).toHaveBeenCalledWith({ wp_user_id: 5230 });
    });
});

describe('database savable models', () => {
    test('normalizes inserted ids returned by sqlite and other knex clients', () => {
        expect(DatabaseSavable.normalizeInsertedId([{ id: 5230 }])).toBe(5230);
        expect(DatabaseSavable.normalizeInsertedId([5230])).toBe(5230);
        expect(DatabaseSavable.normalizeInsertedId(5230)).toBe(5230);
    });
});
