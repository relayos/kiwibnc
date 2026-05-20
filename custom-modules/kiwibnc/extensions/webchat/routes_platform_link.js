const createLogger = require('../../libs/logger');
const crypto = require('crypto');

const l = createLogger('webchat-platform-link');
const PLATFORM_LINKS_TABLE = 'relayos_platform_links';
const PLATFORM_SUBJECT_COLUMN = 'platform_subject_id';
const PLATFORM_CACHE_TABLE = 'relayos_platform_entitlement_cache';
const PLATFORM_LINK_STATE_COOKIE = 'relaybnc_platform_link_state';

function confValue(app, envKey, webKey, def = '') {
    const webchat = app && app.conf && typeof app.conf.get === 'function'
        ? (app.conf.get('webchat') || {})
        : {};
    return process.env[envKey] || webchat[webKey] || def;
}

function buildPlatformLinkConfig(app) {
    const authUrl = confValue(app, 'RELAYOS_PLATFORM_OAUTH_AUTH_URL', 'platform_oauth_auth_url');
    const tokenUrl = confValue(app, 'RELAYOS_PLATFORM_OAUTH_TOKEN_URL', 'platform_oauth_token_url');
    const clientId = confValue(app, 'RELAYOS_PLATFORM_OAUTH_CLIENT_ID', 'platform_oauth_client_id');
    const clientSecret = confValue(app, 'RELAYOS_PLATFORM_OAUTH_CLIENT_SECRET', 'platform_oauth_client_secret');
    const redirectUri = confValue(app, 'RELAYOS_PLATFORM_OAUTH_REDIRECT_URI', 'platform_oauth_redirect_uri');
    const userinfoUrl = confValue(app, 'RELAYOS_PLATFORM_OAUTH_USERINFO_URL', 'platform_oauth_userinfo_url');
    const snapshotUrl = confValue(app, 'RELAYOS_PLATFORM_ENTITLEMENT_SNAPSHOT_URL', 'platform_entitlement_snapshot_url');
    const platformIssuer = confValue(app, 'RELAYOS_PLATFORM_ISSUER', 'platform_issuer', 'platform:relayos-platform');
    const tenantId = confValue(app, 'RELAYOS_TENANT_ID', 'tenant_id', 'relayos-tenant');

    if (!authUrl || !tokenUrl || !clientId || !clientSecret || !redirectUri || !userinfoUrl || !snapshotUrl) {
        return null;
    }

    return {
        authUrl,
        tokenUrl,
        clientId,
        clientSecret,
        redirectUri,
        userinfoUrl,
        snapshotUrl,
        platformIssuer,
        tenantId,
        linksTable: PLATFORM_LINKS_TABLE,
        cacheTable: PLATFORM_CACHE_TABLE,
        subjectColumn: PLATFORM_SUBJECT_COLUMN,
    };
}

// Platform links are tenant WordPress state: they bind a tenant-local wp_users.ID
// to a platform subject and never provision or mutate platform WordPress users.
function tenantUserFromSession(ctx, user) {
    const state = ctx && ctx.state ? ctx.state : {};
    const authUser = user || state.user || state.authUser || null;
    const wpUserId = authUser && (authUser.wp_user_id || authUser.wpUserId);

    if (!wpUserId) {
        return null;
    }

    return {
        wpUserId,
        userId: authUser.id,
        username: authUser.username || authUser.user_login || '',
    };
}

function bearerToken(ctx) {
    // Authorization: Bearer <token>
    const authorization = (ctx.headers && ctx.headers.authorization) || '';
    const parts = authorization.split(/\s+/);
    if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
        return parts[1];
    }
    return '';
}

async function tenantUserFromBearerToken(ctx, app) {
    const token = bearerToken(ctx);
    if (!token || !app.userDb || typeof app.userDb.authUserToken !== 'function') {
        return null;
    }

    const user = await app.userDb.authUserToken(token, ctx.ip);
    return tenantUserFromSession(ctx, user);
}

function setPlatformLinkStateCookie(ctx, app, tenantUser, state) {
    const payload = JSON.stringify({
        state,
        userId: tenantUser.userId,
        wpUserId: tenantUser.wpUserId,
        username: tenantUser.username,
        expires: Date.now() + (5 * 60 * 1000),
    });
    ctx.cookies.set(PLATFORM_LINK_STATE_COOKIE, app.crypt.encrypt(payload), {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 5 * 60 * 1000,
    });
}

function clearPlatformLinkStateCookie(ctx) {
    ctx.cookies.set(PLATFORM_LINK_STATE_COOKIE, null, { maxAge: 0 });
}

function readPlatformLinkStateCookie(ctx, app) {
    const raw = ctx.cookies.get(PLATFORM_LINK_STATE_COOKIE) || '';
    const decrypted = raw && app.crypt ? app.crypt.decrypt(raw) : '';
    if (!decrypted) {
        return null;
    }
    try {
        const payload = JSON.parse(decrypted);
        if (!payload.state || payload.state !== ctx.query.state || Date.now() > Number(payload.expires || 0)) {
            return null;
        }
        if (!payload.wpUserId) {
            return null;
        }
        return {
            userId: payload.userId,
            wpUserId: payload.wpUserId,
            username: payload.username || '',
        };
    } catch (err) {
        return null;
    }
}

function respondAuthRequired(ctx) {
    ctx.status = 401;
    ctx.body = { error: 'Platform account link requires BNC login' };
}

async function requestJson(url, options) {
    if (typeof fetch !== 'function') {
        throw new Error('Platform account linking requires global fetch support');
    }

    const response = await fetch(url, options);
    const body = await response.text();
    let parsed = {};
    if (body) {
        parsed = JSON.parse(body);
    }
    if (!response.ok) {
        const err = new Error(`Platform request failed with HTTP ${response.status}`);
        err.status = response.status;
        err.body = parsed;
        throw err;
    }
    return parsed;
}

async function exchangePlatformOauthCode(config, code, httpPost) {
    const post = httpPost || ((url, options) => requestJson(url, { method: 'POST', ...options }));
    const grantType = 'grant_type=authorization_code';
    const body = [
        grantType,
        `code=${encodeURIComponent(code)}`,
        `client_id=${encodeURIComponent(config.clientId)}`,
        `client_secret=${encodeURIComponent(config.clientSecret)}`,
        `redirect_uri=${encodeURIComponent(config.redirectUri)}`,
    ].join('&');
    const token = await post(config.tokenUrl, {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
    });
    const accessToken = token.access_token || token.accessToken;
    if (!accessToken) {
        throw new Error('Platform OAuth token response missing access_token');
    }

    const userinfo = await requestJson(config.userinfoUrl, {
        headers: { authorization: `Bearer ${accessToken}` },
    });
    const platformUserId = userinfo.platform_user_id || userinfo.wp_user_id || userinfo.id || userinfo.sub;
    const platformSubjectId = userinfo.platform_subject_id || `wp_user:${platformUserId}`;
    if (!platformUserId || !platformSubjectId) {
        throw new Error('Platform OAuth userinfo missing platform_user_id or platform_subject_id');
    }

    return {
        access_token: accessToken,
        platform_user_id: platformUserId,
        platform_subject_id: platformSubjectId,
        userinfo,
    };
}

async function fetchPlatformEntitlementSnapshot(config, platformUserId, httpGet) {
    const get = httpGet || ((url, options) => requestJson(url, { method: 'GET', ...options }));
    const url = new URL(config.snapshotUrl);
    url.searchParams.set('wp_user_id', String(platformUserId));
    return get(url.toString(), {});
}

async function upsertPlatformAccountLink(config, tenantUser, platformSubjectId, db) {
    await db.raw(
        [
            'INSERT INTO `relayos_platform_links`',
            '  (tenant_id, wp_user_id, platform_issuer, platform_subject_id, status, linked_at, updated_at)',
            "VALUES (?, ?, ?, ?, 'active', NOW(), NOW())",
            "ON DUPLICATE KEY UPDATE status = 'active', updated_at = NOW()",
        ].join('\n'),
        [config.tenantId, tenantUser.wpUserId, config.platformIssuer, platformSubjectId]
    );
}

async function cachePlatformEntitlementSnapshot(config, tenantUser, platformSubjectId, snapshot, db) {
    const platformIssuer = snapshot.platform_issuer || config.platformIssuer;
    const snapshotSubjectId = snapshot.platform_subject_id || platformSubjectId;
    const entitlements = Array.isArray(snapshot.entitlements) ? snapshot.entitlements : [];
    await db.raw(
        [
            'DELETE FROM `relayos_platform_entitlement_cache`',
            'WHERE tenant_id = ?',
            '  AND wp_user_id = ?',
            '  AND platform_issuer = ?',
            '  AND platform_subject_id = ?',
        ].join('\n'),
        [config.tenantId, tenantUser.wpUserId, platformIssuer, snapshotSubjectId]
    );

    for (const entitlement of entitlements) {
        const entitlementKey = entitlement.entitlement_key || entitlement.key;
        if (!entitlementKey) {
            continue;
        }
        await db.raw(
            [
                'INSERT INTO `relayos_platform_entitlement_cache`',
                '  (tenant_id, wp_user_id, platform_issuer, platform_subject_id, entitlement_key, status, synced_at)',
                'VALUES (?, ?, ?, ?, ?, ?, NOW())',
                'ON DUPLICATE KEY UPDATE status = VALUES(status), synced_at = NOW()',
            ].join('\n'),
            [
                config.tenantId,
                tenantUser.wpUserId,
                platformIssuer,
                snapshotSubjectId,
                entitlementKey,
                entitlement.status || 'active',
            ]
        );
    }

    return { synced: true, entitlements: entitlements.length };
}

async function syncPlatformEntitlementSnapshot(config, tenantUser, platformSubjectId, platformUserId, db, httpGet) {
    const snapshot = await fetchPlatformEntitlementSnapshot(config, platformUserId, httpGet);
    return cachePlatformEntitlementSnapshot(config, tenantUser, platformSubjectId, snapshot, db);
}

function registerPlatformLinkRoutes(app) {
    const config = buildPlatformLinkConfig(app);
    if (!config) {
        l.info('Platform account-link config missing; skipping platform link routes');
        return null;
    }

    const router = app.webserver.router;
    const db = app.db && app.db.dbUsers;

    router.get('/platform/link', async (ctx) => {
        const tenantUser = await tenantUserFromBearerToken(ctx, app);
        if (!tenantUser) {
            respondAuthRequired(ctx);
            return;
        }

        const state = crypto.randomBytes(16).toString('hex');
        setPlatformLinkStateCookie(ctx, app, tenantUser, state);

        const url = new URL(config.authUrl);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('client_id', config.clientId);
        url.searchParams.set('redirect_uri', config.redirectUri);
        url.searchParams.set('state', state);
        ctx.body = { url: url.toString() };
    });

    router.get('/platform/callback', async (ctx) => {
        const tenantUser = readPlatformLinkStateCookie(ctx, app);
        if (!tenantUser) {
            respondAuthRequired(ctx);
            return;
        }
        if (!ctx.query.code) {
            ctx.status = 400;
            ctx.body = { error: 'Missing platform OAuth code' };
            return;
        }
        if (!db) {
            ctx.status = 503;
            ctx.body = { error: 'Tenant database unavailable' };
            return;
        }
        clearPlatformLinkStateCookie(ctx);

        const platformIdentity = await exchangePlatformOauthCode(config, ctx.query.code);
        await upsertPlatformAccountLink(config, tenantUser, platformIdentity.platform_subject_id, db);
        const sync = await syncPlatformEntitlementSnapshot(
            config,
            tenantUser,
            platformIdentity.platform_subject_id,
            platformIdentity.platform_user_id,
            db
        );
        ctx.body = {
            message: 'Platform account linked',
            tenant_id: config.tenantId,
            platform_issuer: config.platformIssuer,
            platform_subject_id: platformIdentity.platform_subject_id,
            platform_user_id: platformIdentity.platform_user_id,
            synced_entitlements: sync.entitlements,
        };
    });

    return config;
}

function getPlatformLinkClientConfig(config) {
    if (!config) {
        return null;
    }

    return {
        link_url: '/platform/link',
    };
}

module.exports = {
    registerPlatformLinkRoutes,
    getPlatformLinkClientConfig,
    buildPlatformLinkConfig,
    exchangePlatformOauthCode,
    fetchPlatformEntitlementSnapshot,
    upsertPlatformAccountLink,
    cachePlatformEntitlementSnapshot,
    syncPlatformEntitlementSnapshot,
    __testHooks: {
        tenantUserFromSession,
        tenantUserFromBearerToken,
        setPlatformLinkStateCookie,
        readPlatformLinkStateCookie,
        requestJson,
    },
};
