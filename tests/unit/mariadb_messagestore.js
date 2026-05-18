jest.mock('../../custom-modules/kiwibnc/libs/stats', () => {
    const mockStats = {
        timerStart: jest.fn(() => ({ stop: jest.fn() })),
        makePrefix: jest.fn(() => mockStats),
    };
    return {
        instance: jest.fn(() => mockStats),
    };
}, { virtual: true });

jest.mock('../../custom-modules/kiwibnc/libs/helpers', () => ({
    extractBufferName: jest.fn(() => '#test'),
    isoTime: jest.fn(() => '2026-05-18T00:00:00.000Z'),
}), { virtual: true });

jest.mock('mysql', () => ({
    createPool: jest.fn(() => ({
        on: jest.fn(),
        query: jest.fn(),
    })),
}));

const mysql = require('mysql');
const MariaDbMessageStore = require('../../custom-modules/kiwibnc/worker/messagestores/mariadb');

describe('MariaDbMessageStore connection config', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('parses mysql message dsn with raw slash password', () => {
        const connection = MariaDbMessageStore.parseMysqlConnectionString(
            'mysql://editor:raw/pass@db.example:3307/relayos'
        );

        expect(connection.host).toBe('db.example');
        expect(connection.port).toBe(3307);
        expect(connection.user).toBe('editor');
        expect(connection.password).toBe('raw/pass');
        expect(connection.database).toBe('relayos');
    });

    test('initializes mysql pool from parsed message dsn', async () => {
        const store = new MariaDbMessageStore({
            get: jest.fn((key) => {
                if (key === 'message_store_mariadb') {
                    return {
                        messages_dsn: 'mysql://editor:raw/pass@db.example:3307/relayos',
                        auto_migrate: false,
                    };
                }
                if (key === 'database') {
                    return { table_prefix: 'bnc_' };
                }
                return {};
            }),
        });

        await store.init();

        expect(mysql.createPool).toHaveBeenCalledWith({
            host: 'db.example',
            port: 3307,
            user: 'editor',
            password: 'raw/pass',
            database: 'relayos',
        });
    });
});
