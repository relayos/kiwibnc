'use strict';

const { EventEmitter } = require('events');
const https = require('https');

jest.mock('../../src/libs/logger', () => () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
}));

const {
    registerRoutes,
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

function makeHttpsRequestSequence(sequence) {
    const calls = [];
    const bodies = [];
    const spy = jest.spyOn(https, 'request').mockImplementation((options, cb) => {
        const response = sequence.shift();
        if (!response) {
            throw new Error('unexpected https request');
        }
        const req = new EventEmitter();
        req.write = jest.fn((chunk) => {
            bodies.push(String(chunk));
        });
        req.end = jest.fn(() => {
            calls.push(options);
            const res = new EventEmitter();
            res.statusCode = response.statusCode || 200;
            res.headers = response.headers || {};
            cb(res);
            process.nextTick(() => {
                if (response.body) {
                    res.emit('data', response.body);
                }
                res.emit('end');
            });
        });
        return req;
    });
    return { spy, calls, bodies };
}

describe('routes_oauth allowlist config', () => {
    beforeEach(() => {
        jest.resetAllMocks();
        for (const key of OAUTH_ENV_KEYS) {
            delete process.env[key];
        }
    });

    test('parseAllowlist returns an object for valid json', () => {
        expect(__testHooks.parseAllowlist('{"allenday":"admin"}')).toEqual({
            allenday: 'admin',
        });
    });

    test('parseAllowlist rejects non-string allowlist targets', () => {
        expect(() => __testHooks.parseAllowlist('{"allenday":42}')).toThrow(
            'RELAYOS_KIWIBNC_OAUTH_ALLOWLIST_JSON values must be non-empty strings'
        );
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
        expect(conf.provider).toBe('RelayOS');
        expect(conf.allowRegistration).toBe(false);
    });

    test('buildOauthConfig returns null when allowlist is empty', () => {
        setOauthEnv({
            KIWIBNC_OAUTH_CLIENT_ID: 'client-id',
            KIWIBNC_OAUTH_CLIENT_SECRET: 'client-secret',
            KIWIBNC_OAUTH_AUTH_URL: 'https://users.s.getrelayos.com/oauth/authorize',
            KIWIBNC_OAUTH_TOKEN_URL: 'https://users.s.getrelayos.com/oauth/token',
            KIWIBNC_OAUTH_REDIRECT_URI: 'https://bnc.s.getrelayos.com/oauth/callback',
            RELAYOS_KIWIBNC_OAUTH_ALLOWLIST_JSON: '{}',
        });

        expect(buildOauthConfig({
            conf: {
                get: jest.fn((key, def) => (key === 'webchat' ? {} : def)),
            },
        })).toBeNull();
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
                getUser: jest.fn().mockResolvedValue(user),
            },
        };

        await expect(__testHooks.loadMappedUser(app, 'admin')).resolves.toBe(user);
        expect(app.userDb.getUser).toHaveBeenCalledWith('admin');
    });

    test('loadMappedUser rejects missing local user', async () => {
        const app = {
            userDb: {
                getUser: jest.fn().mockResolvedValue(null),
            },
        };

        await expect(__testHooks.loadMappedUser(app, 'admin')).rejects.toThrow(
            'Mapped KiwiBNC user does not exist'
        );
    });
});

describe('routes_oauth callback route', () => {
    beforeEach(() => {
        jest.resetAllMocks();
        for (const key of OAUTH_ENV_KEYS) {
            delete process.env[key];
        }
    });

    test('callback exchanges token, resolves allowlist, and issues a mapped user token', async () => {
        setOauthEnv({
            KIWIBNC_OAUTH_CLIENT_ID: 'client-id',
            KIWIBNC_OAUTH_CLIENT_SECRET: 'client-secret',
            KIWIBNC_OAUTH_AUTH_URL: 'https://users.s.getrelayos.com/oauth/authorize',
            KIWIBNC_OAUTH_TOKEN_URL: 'https://users.s.getrelayos.com/oauth/token',
            KIWIBNC_OAUTH_REDIRECT_URI: 'https://bnc.s.getrelayos.com/oauth/callback',
            KIWIBNC_OAUTH_USERINFO_URL: 'https://users.s.getrelayos.com/oauth/me',
            RELAYOS_KIWIBNC_OAUTH_ALLOWLIST_JSON: '{"allenday":"admin"}',
        });

        const routes = {};
        const app = {
            conf: {
                get: jest.fn((key) => (key === 'webchat' ? {} : false)),
            },
            webserver: {
                router: {
                    get: jest.fn((path, handler) => {
                        routes[path] = handler;
                    }),
                },
            },
            userDb: {
                getUser: jest.fn().mockResolvedValue({ id: 7, username: 'admin' }),
                generateUserToken: jest.fn().mockResolvedValue('token-123'),
            },
        };

        registerRoutes(app);
        expect(routes['/oauth/callback']).toEqual(expect.any(Function));

        const httpsMock = makeHttpsRequestSequence([
            { body: JSON.stringify({ access_token: 'access-123', id_token: 'header.eyJ1c2VyX2xvZ2luIjoiYWxsZW5kYXkifQ.sig' }) },
            { body: JSON.stringify({ email: 'ops@getrelayos.com' }) },
        ]);

        const ctx = {
            query: { code: 'auth-code', state: 'state-123' },
            cookies: {
                get: jest.fn(() => 'state-123'),
                set: jest.fn(),
            },
            ip: '127.0.0.1',
        };

        await routes['/oauth/callback'](ctx);

        expect(ctx.status).toBeUndefined();
        expect(ctx.type).toBe('text/html');
        expect(ctx.body).toContain('kiwibnc_oauth_login');
        expect(app.userDb.getUser).toHaveBeenCalledWith('admin');
        expect(app.userDb.generateUserToken).toHaveBeenCalledWith(7, 7 * 24 * 3600, 'oauth-login', '127.0.0.1');
        expect(httpsMock.spy).toHaveBeenCalledTimes(2);
        expect(httpsMock.calls[0]).toMatchObject({
            method: 'POST',
            hostname: 'users.s.getrelayos.com',
            path: '/oauth/token',
        });
        expect(httpsMock.bodies[0]).toContain('grant_type=authorization_code');
        expect(httpsMock.bodies[0]).toContain('code=auth-code');
        expect(httpsMock.bodies[0]).toContain('redirect_uri=https%3A%2F%2Fbnc.s.getrelayos.com%2Foauth%2Fcallback');
        expect(httpsMock.bodies[0]).toContain('client_id=client-id');
        expect(httpsMock.bodies[0]).toContain('client_secret=client-secret');
        expect(httpsMock.calls[1]).toMatchObject({
            method: 'GET',
            hostname: 'users.s.getrelayos.com',
            path: '/oauth/me',
            headers: {
                Authorization: 'Bearer access-123',
            },
        });
        httpsMock.spy.mockRestore();
    });

    test('callback rejects a bad oauth state before network calls', async () => {
        setOauthEnv({
            KIWIBNC_OAUTH_CLIENT_ID: 'client-id',
            KIWIBNC_OAUTH_CLIENT_SECRET: 'client-secret',
            KIWIBNC_OAUTH_AUTH_URL: 'https://users.s.getrelayos.com/oauth/authorize',
            KIWIBNC_OAUTH_TOKEN_URL: 'https://users.s.getrelayos.com/oauth/token',
            KIWIBNC_OAUTH_REDIRECT_URI: 'https://bnc.s.getrelayos.com/oauth/callback',
            KIWIBNC_OAUTH_USERINFO_URL: 'https://users.s.getrelayos.com/oauth/me',
            RELAYOS_KIWIBNC_OAUTH_ALLOWLIST_JSON: '{"allenday":"admin"}',
        });

        const routes = {};
        const app = {
            conf: {
                get: jest.fn((key) => (key === 'webchat' ? {} : false)),
            },
            webserver: {
                router: {
                    get: jest.fn((path, handler) => {
                        routes[path] = handler;
                    }),
                },
            },
            userDb: {
                getUser: jest.fn(),
                generateUserToken: jest.fn(),
            },
        };

        registerRoutes(app);

        const httpsSpy = jest.spyOn(https, 'request').mockImplementation(() => {
            throw new Error('network should not be called');
        });

        const ctx = {
            query: { code: 'auth-code', state: 'bad-state' },
            cookies: {
                get: jest.fn(() => 'state-123'),
                set: jest.fn(),
            },
            ip: '127.0.0.1',
        };

        await routes['/oauth/callback'](ctx);

        expect(ctx.status).toBe(400);
        expect(ctx.body).toContain('OAuth state mismatch. Please try again.');
        expect(app.userDb.getUser).not.toHaveBeenCalled();
        expect(app.userDb.generateUserToken).not.toHaveBeenCalled();
        expect(httpsSpy).not.toHaveBeenCalled();
        httpsSpy.mockRestore();
    });
});
