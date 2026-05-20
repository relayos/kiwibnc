const createLogger = require('../../libs/logger');

const l = createLogger('webchat-platform-link');
const PLATFORM_LINKS_TABLE = 'relayos_platform_links';
const PLATFORM_SUBJECT_COLUMN = 'platform_subject_id';

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
    const snapshotUrl = confValue(app, 'RELAYOS_PLATFORM_ENTITLEMENT_SNAPSHOT_URL', 'platform_entitlement_snapshot_url');
    const platformIssuer = confValue(app, 'RELAYOS_PLATFORM_ISSUER', 'platform_issuer', 'platform:relayos-platform');
    const tenantId = confValue(app, 'RELAYOS_TENANT_ID', 'tenant_id', 'relayos-tenant');

    if (!authUrl || !tokenUrl || !clientId || !clientSecret || !redirectUri || !snapshotUrl) {
        return null;
    }

    return {
        authUrl,
        tokenUrl,
        clientId,
        clientSecret,
        redirectUri,
        snapshotUrl,
        platformIssuer,
        tenantId,
        linksTable: PLATFORM_LINKS_TABLE,
        subjectColumn: PLATFORM_SUBJECT_COLUMN,
    };
}

function tenantUserFromSession(ctx) {
    const state = ctx && ctx.state ? ctx.state : {};
    const user = state.user || state.authUser || null;
    const wpUserId = user && (user.wp_user_id || user.wpUserId);

    if (!wpUserId) {
        return null;
    }

    return {
        wpUserId,
        username: user.username || user.user_login || '',
    };
}

async function syncPlatformEntitlementSnapshot(config, tenantUser, platformSubjectId) {
    // Link-time sync is intentionally separate from tenant WordPress OAuth.
    // Platform webhooks keep this cache current after the initial snapshot.
    l.info('Platform entitlement snapshot sync queued', {
        tenantId: config.tenantId,
        platformIssuer: config.platformIssuer,
        wpUserId: tenantUser.wpUserId,
        platformSubjectId,
    });
    return { synced: false };
}

function registerPlatformLinkRoutes(app) {
    const config = buildPlatformLinkConfig(app);
    if (!config) {
        l.info('Platform account-link config missing; skipping platform link routes');
        return null;
    }

    const router = app.webserver.router;

    router.get('/platform/link', async (ctx) => {
        const tenantUser = tenantUserFromSession(ctx);
        if (!tenantUser) {
            ctx.status = 401;
            ctx.body = { error: 'No tenant user session' };
            return;
        }

        ctx.body = {
            error: 'not_implemented',
            message: 'Platform account linking is configured but OAuth redirect handling is not enabled in this slice.',
            tenant_id: config.tenantId,
            issuer: config.platformIssuer,
        };
    });

    return config;
}

module.exports = {
    registerPlatformLinkRoutes,
    buildPlatformLinkConfig,
    syncPlatformEntitlementSnapshot,
    __testHooks: {
        tenantUserFromSession,
    },
};
