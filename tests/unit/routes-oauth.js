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
    getClientConfig,
} = require('../../src/extensions/webchat/routes_oauth');

const OAUTH_ENV_KEYS = [
    'KIWIBNC_OAUTH_CLIENT_ID',
    'KIWIBNC_OAUTH_CLIENT_SECRET',
    'KIWIBNC_OAUTH_AUTH_URL',
    'KIWIBNC_OAUTH_TOKEN_URL',
    'KIWIBNC_OAUTH_REDIRECT_URI',
    'KIWIBNC_OAUTH_USERINFO_URL',
    'KIWIBNC_OAUTH_SCOPE',
    'RELAYOS_KIWIBNC_DEFAULT_NETWORK_NAME',
    'RELAYOS_KIWIBNC_DEFAULT_NETWORK_HOST',
    'RELAYOS_KIWIBNC_DEFAULT_NETWORK_PORT',
    'RELAYOS_KIWIBNC_DEFAULT_NETWORK_TLS',
    'RELAYOS_KIWIBNC_DEFAULT_NETWORK_CHANNELS',
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

function makeApp(userDb) {
    const routes = {};
    return {
        routes,
        app: {
            conf: {
                get: jest.fn((key, def) => (key === 'webchat' ? {} : def)),
            },
            webserver: {
                router: {
                    get: jest.fn((path, handler) => {
                        routes[path] = handler;
                    }),
                },
            },
            userDb,
        },
    };
}

function setCompleteOauthEnv(extra = {}) {
    setOauthEnv({
        KIWIBNC_OAUTH_CLIENT_ID: 'client-id',
        KIWIBNC_OAUTH_CLIENT_SECRET: 'client-secret',
        KIWIBNC_OAUTH_AUTH_URL: 'https://users.s.getrelayos.com/oauth/authorize',
        KIWIBNC_OAUTH_TOKEN_URL: 'https://users.s.getrelayos.com/oauth/token',
        KIWIBNC_OAUTH_REDIRECT_URI: 'https://bnc.s.getrelayos.com/oauth/callback',
        KIWIBNC_OAUTH_USERINFO_URL: 'https://users.s.getrelayos.com/oauth/me',
        ...extra,
    });
}

describe('routes_oauth config', () => {
    beforeEach(() => {
        jest.resetAllMocks();
        for (const key of OAUTH_ENV_KEYS) {
            delete process.env[key];
        }
    });

    test('buildOauthConfig enables routes when provider and client config is complete without allowlist', () => {
        setCompleteOauthEnv({ KIWIBNC_OAUTH_SCOPE: 'openid' });

        const conf = buildOauthConfig({
            conf: {
                get: jest.fn((key, def) => (key === 'webchat' ? {} : def)),
            },
        });

        expect(conf).toMatchObject({
            clientId: 'client-id',
            clientSecret: 'client-secret',
            authUrl: 'https://users.s.getrelayos.com/oauth/authorize',
            tokenUrl: 'https://users.s.getrelayos.com/oauth/token',
            redirectUri: 'https://bnc.s.getrelayos.com/oauth/callback',
            userInfoUrl: 'https://users.s.getrelayos.com/oauth/me',
            scope: 'openid',
            provider: 'RelayOS',
            allowRegistration: true,
            defaultNetwork: {
                name: 'RelayOS',
                host: 'inspircd',
                port: 6667,
                tls: false,
                channels: '',
            },
        });
    });

    test('buildOauthConfig returns null when oauth client config is incomplete', () => {
        setOauthEnv({
            KIWIBNC_OAUTH_CLIENT_ID: 'client-id',
            KIWIBNC_OAUTH_CLIENT_SECRET: 'client-secret',
            KIWIBNC_OAUTH_AUTH_URL: 'https://users.s.getrelayos.com/oauth/authorize',
            KIWIBNC_OAUTH_REDIRECT_URI: 'https://bnc.s.getrelayos.com/oauth/callback',
        });

        expect(buildOauthConfig({
            conf: {
                get: jest.fn((key, def) => (key === 'webchat' ? {} : def)),
            },
        })).toBeNull();
    });

    test('getClientConfig returns login_url when OAuth config is complete', () => {
        const conf = {
            clientId: 'client-id',
            clientSecret: 'client-secret',
            authUrl: 'https://users.s.getrelayos.com/oauth/authorize',
            tokenUrl: 'https://users.s.getrelayos.com/oauth/token',
            redirectUri: 'https://bnc.s.getrelayos.com/oauth/callback',
            provider: 'RelayOS',
        };

        expect(getClientConfig(conf)).toEqual({
            login_url: '/oauth/login',
            provider: 'RelayOS',
        });
    });
});

describe('routes_oauth wordpress identity resolution', () => {
    test('resolveWordPressIdentity returns user_login as the local username', () => {
        expect(__testHooks.resolveWordPressIdentity({
            user_login: 'allenday',
            email: 'ops@getrelayos.com',
        })).toEqual({
            username: 'allenday',
        });
    });

    test('resolveWordPressIdentity rejects missing user_login', () => {
        expect(() =>
            __testHooks.resolveWordPressIdentity({ email: 'ops@getrelayos.com' })
        ).toThrow('OAuth userinfo missing user_login');
    });

    test('resolveWordPressIdentity rejects invalid BNC username', () => {
        expect(() =>
            __testHooks.resolveWordPressIdentity({ user_login: 'bad user' })
        ).toThrow('OAuth user_login is not a valid BNC username');
    });
});

describe('routes_oauth local account resolution', () => {
    const defaultNetwork = {
        name: 'RelayOS',
        host: 'inspircd',
        port: 6667,
        tls: false,
        channels: '',
    };

    test('ensureOAuthUser returns existing local user and seeds missing default network', async () => {
        const user = { id: 7, username: 'allenday' };
        const app = {
            userDb: {
                getUser: jest.fn().mockResolvedValue(user),
                getNetworkByName: jest.fn().mockResolvedValue(null),
                addNetwork: jest.fn().mockResolvedValue({ name: 'RelayOS' }),
            },
        };

        await expect(__testHooks.ensureOAuthUser(app, 'allenday', defaultNetwork)).resolves.toBe(user);

        expect(app.userDb.getUser).toHaveBeenCalledWith('allenday');
        expect(app.userDb.getNetworkByName).toHaveBeenCalledWith(7, 'RelayOS');
        expect(app.userDb.addNetwork).toHaveBeenCalledWith(7, {
            name: 'RelayOS',
            host: 'inspircd',
            port: 6667,
            tls: false,
            nick: 'allenday',
            username: 'allenday',
            realname: 'allenday',
            channels: '',
        });
    });

    test('ensureOAuthUser creates a missing local user as non-admin and seeds default network', async () => {
        const created = { id: 9, username: 'newuser' };
        const app = {
            userDb: {
                getUser: jest.fn().mockResolvedValue(null),
                addUser: jest.fn().mockResolvedValue(created),
                getNetworkByName: jest.fn().mockResolvedValue(null),
                addNetwork: jest.fn().mockResolvedValue({ name: 'RelayOS' }),
            },
        };

        await expect(__testHooks.ensureOAuthUser(app, 'newuser', defaultNetwork)).resolves.toBe(created);

        expect(app.userDb.addUser).toHaveBeenCalledWith(
            'newuser',
            expect.stringMatching(/^oauth-unusable-/),
            false
        );
        expect(app.userDb.addNetwork).toHaveBeenCalledWith(9, {
            name: 'RelayOS',
            host: 'inspircd',
            port: 6667,
            tls: false,
            nick: 'newuser',
            username: 'newuser',
            realname: 'newuser',
            channels: '',
        });
    });

    test('ensureOAuthUser does not seed network when default network already exists', async () => {
        const user = { id: 7, username: 'allenday' };
        const app = {
            userDb: {
                getUser: jest.fn().mockResolvedValue(user),
                getNetworkByName: jest.fn().mockResolvedValue({ name: 'RelayOS' }),
                addNetwork: jest.fn(),
            },
        };

        await expect(__testHooks.ensureOAuthUser(app, 'allenday', defaultNetwork)).resolves.toBe(user);

        expect(app.userDb.addNetwork).not.toHaveBeenCalled();
    });
});

describe('routes_oauth callback route', () => {
    beforeEach(() => {
        jest.resetAllMocks();
        for (const key of OAUTH_ENV_KEYS) {
            delete process.env[key];
        }
    });

    test('callback exchanges token, resolves wordpress user_login, and issues an existing user token', async () => {
        setCompleteOauthEnv();

        const { app, routes } = makeApp({
            getUser: jest.fn().mockResolvedValue({ id: 7, username: 'allenday' }),
            getNetworkByName: jest.fn().mockResolvedValue({ name: 'RelayOS' }),
            addNetwork: jest.fn(),
            generateUserToken: jest.fn().mockResolvedValue('token-123'),
        });

        registerRoutes(app);
        expect(routes['/oauth/callback']).toEqual(expect.any(Function));

        const httpsMock = makeHttpsRequestSequence([
            { body: JSON.stringify({ access_token: 'access-123' }) },
            { body: JSON.stringify({ user_login: 'allenday', email: 'ops@getrelayos.com' }) },
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
        expect(ctx.body).toContain('"username":"allenday"');
        expect(app.userDb.getUser).toHaveBeenCalledWith('allenday');
        expect(app.userDb.addNetwork).not.toHaveBeenCalled();
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

    test('callback creates missing user as non-admin and seeds default network before issuing token', async () => {
        setCompleteOauthEnv();

        const { app, routes } = makeApp({
            getUser: jest.fn().mockResolvedValue(null),
            addUser: jest.fn().mockResolvedValue({ id: 11, username: 'newuser' }),
            getNetworkByName: jest.fn().mockResolvedValue(null),
            addNetwork: jest.fn().mockResolvedValue({ name: 'RelayOS' }),
            generateUserToken: jest.fn().mockResolvedValue('token-456'),
        });

        registerRoutes(app);

        const httpsMock = makeHttpsRequestSequence([
            { body: JSON.stringify({ access_token: 'access-456' }) },
            { body: JSON.stringify({ user_login: 'newuser' }) },
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

        expect(app.userDb.addUser).toHaveBeenCalledWith(
            'newuser',
            expect.stringMatching(/^oauth-unusable-/),
            false
        );
        expect(app.userDb.addNetwork).toHaveBeenCalledWith(11, {
            name: 'RelayOS',
            host: 'inspircd',
            port: 6667,
            tls: false,
            nick: 'newuser',
            username: 'newuser',
            realname: 'newuser',
            channels: '',
        });
        expect(app.userDb.generateUserToken).toHaveBeenCalledWith(11, 7 * 24 * 3600, 'oauth-login', '127.0.0.1');
        expect(ctx.body).toContain('"username":"newuser"');
        httpsMock.spy.mockRestore();
    });

    test('callback seeds default network for an existing user without one', async () => {
        setCompleteOauthEnv();

        const { app, routes } = makeApp({
            getUser: jest.fn().mockResolvedValue({ id: 12, username: 'existing' }),
            getNetworkByName: jest.fn().mockResolvedValue(null),
            addNetwork: jest.fn().mockResolvedValue({ name: 'RelayOS' }),
            generateUserToken: jest.fn().mockResolvedValue('token-789'),
        });

        registerRoutes(app);

        const httpsMock = makeHttpsRequestSequence([
            { body: JSON.stringify({ access_token: 'access-789' }) },
            { body: JSON.stringify({ user_login: 'existing' }) },
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

        expect(app.userDb.addNetwork).toHaveBeenCalledWith(12, expect.objectContaining({
            name: 'RelayOS',
            host: 'inspircd',
            nick: 'existing',
            username: 'existing',
        }));
        expect(app.userDb.generateUserToken).toHaveBeenCalledWith(12, 7 * 24 * 3600, 'oauth-login', '127.0.0.1');
        httpsMock.spy.mockRestore();
    });

    test('callback rejects missing user_login without calling DB', async () => {
        setCompleteOauthEnv();

        const { app, routes } = makeApp({
            getUser: jest.fn(),
            addUser: jest.fn(),
            getNetworkByName: jest.fn(),
            addNetwork: jest.fn(),
            generateUserToken: jest.fn(),
        });

        registerRoutes(app);

        const httpsMock = makeHttpsRequestSequence([
            { body: JSON.stringify({ access_token: 'access-000' }) },
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

        expect(ctx.status).toBe(400);
        expect(ctx.body).toContain('OAuth userinfo missing user_login');
        expect(app.userDb.getUser).not.toHaveBeenCalled();
        expect(app.userDb.generateUserToken).not.toHaveBeenCalled();
        httpsMock.spy.mockRestore();
    });

    test('callback rejects a bad oauth state before network or DB calls', async () => {
        setCompleteOauthEnv();

        const { app, routes } = makeApp({
            getUser: jest.fn(),
            generateUserToken: jest.fn(),
        });

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
