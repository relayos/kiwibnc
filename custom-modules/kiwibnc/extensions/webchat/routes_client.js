const fs = require('fs-extra');
const path = require('path');
const RelayosEntitlements = require('../../libs/relayos_entitlements');

function isTemplatePlaceholder(value) {
    return typeof value === 'string' && /^\{\{[^}]+\}\}$/.test(value.trim());
}

function resolveStartupValue(existing, fallback) {
    if (existing === undefined || existing === null || existing === '') {
        return fallback;
    }

    if (isTemplatePlaceholder(existing)) {
        return fallback;
    }

    return existing;
}

function parsePublicTls(raw) {
    if (raw === undefined || raw === null || raw === '') {
        return null;
    }

    const value = String(raw).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(value)) {
        return true;
    }
    if (['0', 'false', 'no', 'off'].includes(value)) {
        return false;
    }

    return null;
}

function buildPublicStartupOverrides() {
    const host = process.env.KIWIBNC_PUBLIC_HOST || '';
    const port = parseInt(process.env.KIWIBNC_PUBLIC_PORT || '', 10);
    const tls = parsePublicTls(process.env.KIWIBNC_PUBLIC_TLS);
    const directPath = process.env.KIWIBNC_PUBLIC_PATH || '';

    if (!host && !Number.isFinite(port) && tls === null && !directPath) {
        return null;
    }

    return {
        server: host || '',
        port: Number.isFinite(port) && port > 0 ? port : (tls ? 443 : 80),
        tls: tls === null ? false : tls,
        direct_path: directPath || '/',
    };
}

function buildStartupOptions(ctx) {
    const publicOverrides = buildPublicStartupOverrides();
    if (publicOverrides) {
        return publicOverrides;
    }

    const forwardedProto = ctx.headers && ctx.headers['x-forwarded-proto'];
    const forwardedHost = ctx.headers && ctx.headers['x-forwarded-host'];
    const forwardedPort = ctx.headers && ctx.headers['x-forwarded-port'];
    const host = forwardedHost || ctx.host || ctx.hostname || '';
    const protoValues = String(forwardedProto || ctx.protocol || '')
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
    const isTls = protoValues.includes('https');
    const portMatch = host.match(/:(\d+)$/);
    const port = forwardedPort ?
        parseInt(String(forwardedPort).split(',')[0].trim(), 10) :
        (portMatch ? parseInt(portMatch[1], 10) : NaN);

    return {
        server: host.replace(/:\d+$/, '') || ctx.hostname || '',
        port: Number.isFinite(port) && port > 0 ? port : (isTls ? 443 : 80),
        tls: isTls,
        direct_path: ctx.basePath || '/',
    };
}

async function relayosMetadataUsers(app) {
    const db = app && app.db && app.db.dbUsers;
    if (!db) {
        return [];
    }

    return await db('users')
        .whereNotNull('wp_user_id')
        .select('username', 'wp_user_id');
}

module.exports = function(app, oauthClientConf, platformLinkClientConf) {
    let router = app.webserver.router;

    let publicPath = app.conf.relativePath(app.conf.get('webserver.public_dir'));
    const oauthEnabled = !!(oauthClientConf && oauthClientConf.login_url);
    const relayosEntitlements = new RelayosEntitlements({
        db: app && app.db && app.db.dbUsers,
        logger: global.l || console,
    });
    let relayosEntitlementsReady = null;
    const ensureRelayosEntitlements = async () => {
        if (!relayosEntitlementsReady) {
            relayosEntitlementsReady = relayosEntitlements.init();
        }
        await relayosEntitlementsReady;
        return relayosEntitlements;
    };

    router.get('kiwi.bnc_plugin', '/kiwibnc_plugin.html', async (ctx, next) => {
        ctx.body = await fs.readFile(
            path.join(__dirname, 'kiwibnc_plugin.html'),
            { encoding: 'utf8' },
        );
    });

    router.get('kiwi.relayos_badges', '/relayos_badges.js', async (ctx, next) => {
        ctx.type = 'application/javascript';
        ctx.body = await fs.readFile(
            path.join(__dirname, 'relayos_badges.js'),
            { encoding: 'utf8' },
        );
    });

    router.get('kiwi.relayos_metadata', '/relayos_metadata.json', async (ctx, next) => {
        const resolver = await ensureRelayosEntitlements();

        const users = {};
        const rows = await relayosMetadataUsers(app);
        const overlayUsers = Object.keys(resolver.overlayUsers || {}).map((username) => ({ username }));
        const seen = new Set();

        for (const row of rows.concat(overlayUsers)) {
            const username = String(row.username || '').trim();
            const key = username.toLowerCase();
            if (!username || seen.has(key)) {
                continue;
            }
            seen.add(key);

            const metadata = await resolver.projectUserMetadata({
                username,
                wp_user_id: row.wp_user_id,
            });
            if (Object.keys(metadata).length) {
                users[username] = metadata;
            }
        }

        ctx.body = { users };
    });

    router.get('kiwi.config', '/static/config.json', async (ctx, next) => {
        let config = await fs.readFile(path.join(publicPath, 'static', 'config.json'));
        config = JSON.parse(config);
        config = {
            ...config,
            '## comment': 'Auto generated by KiwiBNC',
            kiwiServer: '',
            startupScreen: 'kiwibnc',
        };

        const requestStartupOptions = buildStartupOptions(ctx);
        config.startupOptions = {
            ...config.startupOptions,
            server: resolveStartupValue(config.startupOptions.server, requestStartupOptions.server),
            port: resolveStartupValue(config.startupOptions.port, requestStartupOptions.port),
            tls: resolveStartupValue(config.startupOptions.tls, requestStartupOptions.tls),
            direct_path: resolveStartupValue(
                config.startupOptions.direct_path,
                requestStartupOptions.direct_path
            ),
            direct: true,
            channel: '',
            bouncer: true,
            remember_buffers: false,
            public_register : oauthEnabled ? false : app.conf.get('webchat.public_register', false),
        };

        // Add our kiwi plugin to the config
        config.plugins = config.plugins || [];
        config.plugins.push({
            name: 'kiwibnc',
            url: router.url('kiwi.bnc_plugin', {}),
            basePath: ctx.basePath,
        });

        if (oauthClientConf) {
            config.oauth = oauthClientConf;
        }
        if (platformLinkClientConf) {
            config.platform_link = platformLinkClientConf;
        }

        let extraConf = app.conf.get('webchat');
        for (let prop in extraConf) {
            config[prop] = extraConf[prop];
        }

        config.startupOptions = config.startupOptions || {};
        config.startupOptions.public_register = oauthEnabled ?
            false :
            app.conf.get('webchat.public_register', false);
        if (oauthEnabled) {
            config.oauth = oauthClientConf;
        }
        if (platformLinkClientConf) {
            config.platform_link = platformLinkClientConf;
        }

        ctx.body = config;
    });

    app.webserver.router.post('kiwi.config', '/api/register', async (ctx, next) => {
        if (oauthEnabled || !app.conf.get('webchat.public_register', false)) {
            ctx.body = {error: 'forbidden'};
            return;
        }

        let body = ctx.request.body;
        if (!body.username || !body.password) {
            ctx.body = {error: 'missing_params'};
            return;
        }

        if (await app.userDb.getUser(body.username)) {
            ctx.body = {error: 'username_in_use'};
            return;
        }

        let admin = false;

        // If this is the first user, make them an admin
        let usersExist = await app.db.factories.User.query().first();
        if (!usersExist) {
            admin = true;
        }

        try {
            let user = await app.userDb.addUser(body.username, body.password, admin);
        } catch (err) {
            if (err.message === 'Invalid username') {
                ctx.body = {error: 'invalid_username'};
            } else {
                ctx.body = {error: 'unknown_error'};
            }

            return;
        }

        ctx.body = {error: false};
    });
};
