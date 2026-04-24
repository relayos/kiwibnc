'use strict';

jest.mock('fs-extra', () => ({
    readFile: jest.fn(),
}));

const fs = require('fs-extra');
const routesClient = require('../../src/extensions/webchat/routes_client');

function makeRouter() {
    const routes = {};
    return {
        routes,
        get(name, path, handler) {
            routes[name] = { path, handler };
        },
        post() {},
        url(name) {
            return `/mock/${name}`;
        },
    };
}

function makeApp() {
    const router = makeRouter();
    return {
        webserver: { router },
        conf: {
            relativePath: jest.fn(() => '/srv/public'),
            get: jest.fn((key, def) => {
                if (key === 'webchat') {
                    return {};
                }
                if (key === 'webchat.public_register') {
                    return false;
                }
                if (key === 'webserver.public_dir') {
                    return '/srv/public';
                }
                return def;
            }),
        },
    };
}

describe('routes_client config route', () => {
    beforeEach(() => {
        jest.resetAllMocks();
    });

    test('fills startupOptions from the current request instead of template placeholders', async () => {
        fs.readFile.mockResolvedValue(JSON.stringify({
            startupOptions: {
                greetingText: 'KiwiBNC Login',
                server: '{{hostname}}',
                port: '{{port}}',
                tls: '{{tls}}',
                direct_path: '{{direct_path}}',
            },
            plugins: [],
        }));

        const app = makeApp();
        routesClient(app, { login_url: '/oauth/login', provider: 'RelayOS' });
        const route = app.webserver.router.routes['kiwi.config'];

        const ctx = {
            basePath: '/bnc',
            hostname: 'users.s.getrelayos.com',
            host: 'users.s.getrelayos.com',
            protocol: 'https',
            request: {},
        };

        await route.handler(ctx, jest.fn());

        expect(ctx.body.startupOptions).toMatchObject({
            greetingText: 'KiwiBNC Login',
            server: 'users.s.getrelayos.com',
            port: 443,
            tls: true,
            direct_path: '/bnc',
            direct: true,
            channel: '',
            bouncer: true,
            remember_buffers: false,
            public_register: false,
        });
        expect(ctx.body.plugins).toEqual([
            {
                name: 'kiwibnc',
                url: '/mock/kiwi.bnc_plugin',
                basePath: '/bnc',
            },
        ]);
        expect(ctx.body.oauth).toEqual({
            login_url: '/oauth/login',
            provider: 'RelayOS',
        });
    });

    test('preserves explicit startup listener settings from config', async () => {
        fs.readFile.mockResolvedValue(JSON.stringify({
            startupOptions: {
                greetingText: 'KiwiBNC Login',
                server: 'irc.example.net',
                port: 6697,
                tls: true,
                direct_path: '/socket',
            },
            plugins: [],
        }));

        const app = makeApp();
        routesClient(app, { login_url: '/oauth/login', provider: 'RelayOS' });
        const route = app.webserver.router.routes['kiwi.config'];

        const ctx = {
            basePath: '/bnc',
            hostname: 'users.s.getrelayos.com',
            host: 'users.s.getrelayos.com:8443',
            protocol: 'https',
            request: {},
        };

        await route.handler(ctx, jest.fn());

        expect(ctx.body.startupOptions).toMatchObject({
            server: 'irc.example.net',
            port: 6697,
            tls: true,
            direct_path: '/socket',
            direct: true,
        });
    });
});
