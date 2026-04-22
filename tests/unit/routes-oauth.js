'use strict';

jest.mock('../../src/libs/logger', () => () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
}));

const {
    __testHooks,
    buildOauthConfig,
} = require('../../src/extensions/webchat/routes_oauth');

const OAUTH_ENV_KEYS = [
    'KIWIBNC_OAUTH_CLIENT_ID',
    'KIWIBNC_OAUTH_CLIENT_SECRET',
    'KIWIBNC_OAUTH_AUTH_URL',
    'KIWIBNC_OAUTH_TOKEN_URL',
    'KIWIBNC_OAUTH_REDIRECT_URI',
    'KIWIBNC_OAUTH_USERINFO_URL',
    'KIWIBNC_OAUTH_SCOPE',
    'RELAYOS_KIWIBNC_OAUTH_ALLOWLIST_JSON',
];

function setOauthEnv(values) {
    for (const key of OAUTH_ENV_KEYS) {
        delete process.env[key];
    }
    Object.assign(process.env, values);
}

describe('routes_oauth allowlist config', () => {
    beforeEach(() => {
        jest.resetAllMocks();
        for (const key of OAUTH_ENV_KEYS) {
            delete process.env[key];
        }
    });

    test('buildOauthConfig includes parsed allowlist when oauth env is complete', () => {
        setOauthEnv({
            KIWIBNC_OAUTH_CLIENT_ID: 'client-id',
            KIWIBNC_OAUTH_CLIENT_SECRET: 'client-secret',
            KIWIBNC_OAUTH_AUTH_URL: 'https://users.s.getrelayos.com/oauth/authorize',
            KIWIBNC_OAUTH_TOKEN_URL: 'https://users.s.getrelayos.com/oauth/token',
            KIWIBNC_OAUTH_REDIRECT_URI: 'https://bnc.s.getrelayos.com/oauth/callback',
            KIWIBNC_OAUTH_USERINFO_URL: 'https://users.s.getrelayos.com/oauth/me',
            KIWIBNC_OAUTH_SCOPE: 'openid',
            RELAYOS_KIWIBNC_OAUTH_ALLOWLIST_JSON: '{"allenday":"admin"}',
        });

        const conf = buildOauthConfig({
            conf: {
                get: jest.fn((key, def) => (key === 'webchat' ? {} : def)),
            },
        });

        expect(conf.allowlist).toEqual({ allenday: 'admin' });
    });

    test('buildOauthConfig rejects invalid allowlist json', () => {
        setOauthEnv({
            KIWIBNC_OAUTH_CLIENT_ID: 'client-id',
            KIWIBNC_OAUTH_CLIENT_SECRET: 'client-secret',
            KIWIBNC_OAUTH_AUTH_URL: 'https://users.s.getrelayos.com/oauth/authorize',
            KIWIBNC_OAUTH_TOKEN_URL: 'https://users.s.getrelayos.com/oauth/token',
            KIWIBNC_OAUTH_REDIRECT_URI: 'https://bnc.s.getrelayos.com/oauth/callback',
            RELAYOS_KIWIBNC_OAUTH_ALLOWLIST_JSON: '{bad-json',
        });

        expect(() => buildOauthConfig({
            conf: {
                get: jest.fn((key, def) => (key === 'webchat' ? {} : def)),
            },
        })).toThrow(
            'Invalid RELAYOS_KIWIBNC_OAUTH_ALLOWLIST_JSON'
        );
    });

    test('buildOauthConfig rejects non-object allowlist json', () => {
        setOauthEnv({
            KIWIBNC_OAUTH_CLIENT_ID: 'client-id',
            KIWIBNC_OAUTH_CLIENT_SECRET: 'client-secret',
            KIWIBNC_OAUTH_AUTH_URL: 'https://users.s.getrelayos.com/oauth/authorize',
            KIWIBNC_OAUTH_TOKEN_URL: 'https://users.s.getrelayos.com/oauth/token',
            KIWIBNC_OAUTH_REDIRECT_URI: 'https://bnc.s.getrelayos.com/oauth/callback',
            RELAYOS_KIWIBNC_OAUTH_ALLOWLIST_JSON: '[]',
        });

        expect(() => buildOauthConfig({
            conf: {
                get: jest.fn((key, def) => (key === 'webchat' ? {} : def)),
            },
        })).toThrow(
            'RELAYOS_KIWIBNC_OAUTH_ALLOWLIST_JSON must decode to an object'
        );
    });
});

describe('routes_oauth allowlist resolution', () => {
    test('resolveAllowedUser returns mapped local username for allowlisted user_login', () => {
        const result = __testHooks.resolveAllowedUser(
            { allowlist: { allenday: 'admin' } },
            { user_login: 'allenday', email: 'ops@getrelayos.com' }
        );

        expect(result).toEqual({
            remoteLogin: 'allenday',
            localUsername: 'admin',
        });
    });

    test('resolveAllowedUser rejects missing user_login', () => {
        expect(() =>
            __testHooks.resolveAllowedUser(
                { allowlist: { allenday: 'admin' } },
                { email: 'ops@getrelayos.com' }
            )
        ).toThrow('OAuth userinfo missing user_login');
    });

    test('resolveAllowedUser rejects non-allowlisted user_login', () => {
        expect(() =>
            __testHooks.resolveAllowedUser(
                { allowlist: { allenday: 'admin' } },
                { user_login: 'someoneelse' }
            )
        ).toThrow('OAuth account is not approved');
    });
});

describe('routes_oauth local account resolution', () => {
    test('loadMappedUser returns the existing local user', async () => {
        const user = { id: 7, username: 'admin' };
        const app = {
            userDb: {
                getUserByName: jest.fn().mockResolvedValue(user),
            },
        };

        await expect(__testHooks.loadMappedUser(app, 'admin')).resolves.toBe(user);
        expect(app.userDb.getUserByName).toHaveBeenCalledWith('admin');
    });

    test('loadMappedUser rejects missing local user', async () => {
        const app = {
            userDb: {
                getUserByName: jest.fn().mockResolvedValue(null),
            },
        };

        await expect(__testHooks.loadMappedUser(app, 'admin')).rejects.toThrow(
            'Mapped KiwiBNC user does not exist'
        );
    });
});
