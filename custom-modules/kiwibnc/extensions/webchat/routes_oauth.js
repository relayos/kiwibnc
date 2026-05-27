const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { URL, URLSearchParams } = require('url');
const bcrypt = require('bcrypt');
const createLogger = require('../../libs/logger');
const Helpers = require('../../libs/helpers');
const RelayosEntitlements = require('../../libs/relayos_entitlements');
const { ensureBncWordPressProvisioning } = require('./provision_bnc');
const l = createLogger('webchat-oauth');
const DEFAULT_TENANT_ID = process.env.RELAYOS_TENANT_ID || 'relayos-tenant';
const DEFAULT_REQUIRED_ENTITLEMENTS = [
    'relaybnc-subscriber',
    'relaybnc-active-subscriber',
    'active-subscriber',
];

function parseBool(value, def) {
    if (typeof value === 'undefined' || value === null || value === '') {
        return def;
    }
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function parsePort(value, def) {
    const port = Number(value);
    return Number.isInteger(port) && port > 0 ? port : def;
}

function parseList(value, def) {
    const items = String(value || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    return items.length ? items : def.slice();
}

function buildDefaultNetwork(webchat) {
    const conf = (envKey, webKey, def) => {
        return process.env[envKey] || webchat[webKey] || def;
    };

    return {
        name: conf('RELAYOS_KIWIBNC_DEFAULT_NETWORK_NAME', 'oauth_default_network_name', 'RelayOS'),
        host: conf('RELAYOS_KIWIBNC_DEFAULT_NETWORK_HOST', 'oauth_default_network_host', 'inspircd'),
        port: parsePort(conf('RELAYOS_KIWIBNC_DEFAULT_NETWORK_PORT', 'oauth_default_network_port', '6667'), 6667),
        tls: parseBool(conf('RELAYOS_KIWIBNC_DEFAULT_NETWORK_TLS', 'oauth_default_network_tls', 'false'), false),
        channels: conf('RELAYOS_KIWIBNC_DEFAULT_NETWORK_CHANNELS', 'oauth_default_network_channels', ''),
    };
}

function buildOauthConfig(app) {
    const webchat = app && app.conf && typeof app.conf.get === 'function'
        ? (app.conf.get('webchat') || {})
        : {};
    const conf = (envKey, webKey, def = '') => {
        return process.env[envKey] || webchat[webKey] || def;
    };

    const clientId = conf('KIWIBNC_OAUTH_CLIENT_ID', 'oauth_client_id');
    const clientSecret = conf('KIWIBNC_OAUTH_CLIENT_SECRET', 'oauth_client_secret');
    const authUrl = conf('KIWIBNC_OAUTH_AUTH_URL', 'oauth_auth_url');
    const tokenUrl = conf('KIWIBNC_OAUTH_TOKEN_URL', 'oauth_token_url');
    const redirectUri = conf('KIWIBNC_OAUTH_REDIRECT_URI', 'oauth_redirect_uri');
    const userInfoUrl = conf('KIWIBNC_OAUTH_USERINFO_URL', 'oauth_userinfo_url');
    const scope = conf('KIWIBNC_OAUTH_SCOPE', 'oauth_scope', 'openid profile email');
    const tenantId = conf('RELAYOS_TENANT_ID', 'tenant_id', DEFAULT_TENANT_ID);
    const requiredEntitlements = parseList(
        conf('RELAYOS_KIWIBNC_REQUIRED_ENTITLEMENTS', 'oauth_required_entitlements'),
        DEFAULT_REQUIRED_ENTITLEMENTS
    );
    const unentitledRedirectUrl = conf(
        'KIWIBNC_UNENTITLED_REDIRECT_URL',
        'oauth_unentitled_redirect_url',
        'https://chat.s.getrelayos.com/'
    );

    l.info('OAuth config values', {
        clientId: !!clientId,
        clientSecret: clientSecret ? '<redacted>' : '',
        authUrl,
        tokenUrl,
        redirectUri,
        userInfoUrl: userInfoUrl || '',
        scope,
    });

    if (!clientId || !clientSecret || !authUrl || !tokenUrl || !redirectUri) {
        return null;
    }

    return {
        clientId,
        clientSecret,
        authUrl,
        tokenUrl,
        redirectUri,
        userInfoUrl,
        scope,
        provider: 'RelayOS',
        allowRegistration: false,
        defaultNetwork: buildDefaultNetwork(webchat),
        tenantId,
        requiredEntitlements,
        unentitledRedirectUrl,
    };
}

async function httpJson(urlObj, opts, body, redirectDepth = 0) {
    return await new Promise((resolve, reject) => {
        const isHttps = urlObj.protocol === 'https:';
        const req = (isHttps ? https : http).request({
            method: opts.method || 'GET',
            hostname: urlObj.hostname,
            port: urlObj.port || (isHttps ? 443 : 80),
            path: urlObj.pathname + (urlObj.search || ''),
            headers: opts.headers || {},
            rejectUnauthorized: opts.rejectUnauthorized !== false,
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                // Follow simple redirects for userinfo endpoints that issue 301/302
                if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                    if (redirectDepth > 4) {
                        return reject(new Error(`HTTP redirect limit reached`));
                    }
                    const location = res.headers.location;
                    if (!location) {
                        return reject(new Error(`HTTP ${res.statusCode}`));
                    }
                    try {
                        const next = new URL(location, urlObj);
                        return resolve(httpJson(next, opts, body, redirectDepth + 1));
                    } catch (err) {
                        return reject(err);
                    }
                }

                if (res.statusCode < 200 || res.statusCode >= 300) {
                    return reject(new Error(`HTTP ${res.statusCode}`));
                }
                try {
                    resolve(JSON.parse(data || '{}'));
                } catch (err) {
                    reject(new Error('Invalid JSON response'));
                }
            });
        });

        req.on('error', reject);
        if (body) {
            req.write(body);
        }
        req.end();
    });
}

async function exchangeCodeForToken(oauthConf, code) {
    const params = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: oauthConf.redirectUri,
        client_id: oauthConf.clientId,
        client_secret: oauthConf.clientSecret,
    });
    const urlObj = new URL(oauthConf.tokenUrl);
    return await httpJson(urlObj, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(params.toString()),
        },
    }, params.toString());
}

async function fetchUserInfo(oauthConf, token) {
    if (!oauthConf.userInfoUrl) {
        return {};
    }

    const urlObj = new URL(oauthConf.userInfoUrl);
    return await httpJson(urlObj, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${token}`,
        },
    });
}

function setStateCookie(ctx, value) {
    ctx.cookies.set('kiwibnc_oauth_state', value, {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 5 * 60 * 1000,
    });
}

function clearStateCookie(ctx) {
    ctx.cookies.set('kiwibnc_oauth_state', null, { maxAge: 0 });
}

function renderTokenPage(username, token, ttlSeconds) {
    const payload = {
        username,
        token,
        expires: Date.now() + (ttlSeconds * 1000),
    };
    const json = JSON.stringify(payload)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026');

    return `<!doctype html>
<html><body><script>
try {
  localStorage.setItem('kiwibnc_oauth_login', '${json}');
} catch (e) {}
window.location = '/';
</script></body></html>`;
}

function respondError(ctx, message) {
    ctx.status = 400;
    ctx.type = 'text/html';
    ctx.body = `<!doctype html><html><body><p>${message}</p><a href="/">Back</a></body></html>`;
}

function htmlEscape(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderBncUpgradeRedirectPage(ctx, oauthConf) {
    const redirectUrl = oauthConf.unentitledRedirectUrl || 'https://chat.s.getrelayos.com/';
    const safeRedirectUrl = htmlEscape(redirectUrl);
    const jsRedirectUrl = JSON.stringify(redirectUrl)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026');
    ctx.status = 403;
    ctx.type = 'text/html';
    ctx.body = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="8; url=${safeRedirectUrl}">
  <title>RelayBNC subscription required</title>
</head>
<body>
  <div role="dialog" aria-labelledby="relaybnc-upgrade-title" aria-describedby="relaybnc-upgrade-copy">
    <h1 id="relaybnc-upgrade-title">RelayBNC requires an active subscription</h1>
    <p id="relaybnc-upgrade-copy">Your WordPress account is valid, but this BNC is available to RelayBNC subscribers. Continue in KiwiIRC or upgrade from the chat experience.</p>
    <p><a href="${safeRedirectUrl}">Continue to KiwiIRC</a></p>
  </div>
  <script>
    window.setTimeout(function () {
      window.location.href = ${jsRedirectUrl};
    }, 8000);
  </script>
</body>
</html>`;
}

function resolveWordPressIdentity(userInfo) {
    // This OAuth route maps tenant WordPress users to tenant-local BNC users.
    // Platform OAuth account linking is a separate flow and must not provision BNC users.
    const username = userInfo && typeof userInfo.user_login === 'string'
        ? userInfo.user_login.trim()
        : '';
    if (!username) {
        throw new Error('OAuth userinfo missing user_login');
    }

    if (!Helpers.validUsername(username)) {
        throw new Error('OAuth user_login is not a valid BNC username');
    }

    const rawWpUserId = userInfo.ID || userInfo.id || userInfo.sub;
    const wpUserId = Number(rawWpUserId);
    if (!Number.isInteger(wpUserId) || wpUserId <= 0) {
        throw new Error('OAuth userinfo missing WordPress user id');
    }

    return {
        username,
        wpUserId,
    };
}

function generateUnusablePassword() {
    return `oauth-unusable-${crypto.randomBytes(32).toString('hex')}`;
}

function generateRelayBncSaslSecret() {
    return `relaybnc-sasl-${crypto.randomBytes(32).toString('hex')}`;
}

async function ensureRelayBncSaslCredential(app, wpUserId, saslSecret) {
    const knex = app.db && app.db.dbUsers;
    if (!knex || !wpUserId || !saslSecret) {
        return;
    }

    const credentialHash = await bcrypt.hash(saslSecret, 10);
    await knex.raw(
        `INSERT INTO relayos_bnc_sasl_credentials
             (wp_user_id, credential_hash, status, source)
         VALUES (?, ?, 'active', 'kiwibnc-oauth')
         ON DUPLICATE KEY UPDATE
             credential_hash = VALUES(credential_hash),
             status = 'active',
             source = 'kiwibnc-oauth',
             updated_at = CURRENT_TIMESTAMP`,
        [wpUserId, credentialHash]
    );
}

function buildUserNetwork(defaultNetwork, username, saslSecret) {
    return {
        name: defaultNetwork.name,
        host: defaultNetwork.host,
        port: defaultNetwork.port,
        tls: defaultNetwork.tls,
        nick: username,
        username,
        realname: username,
        password: '',
        sasl_account: username,
        sasl_pass: saslSecret,
        channels: defaultNetwork.channels || '',
    };
}

function getUserId(user) {
    if (user && user.id && typeof user.id === 'object' && Object.prototype.hasOwnProperty.call(user.id, 'id')) {
        return user.id.id;
    }

    return user ? user.id : undefined;
}

async function ensureDefaultNetwork(app, user, defaultNetwork, wpUserId) {
    const userId = getUserId(user);
    const username = user.username;
    let network = await app.userDb.getNetworkByName(userId, defaultNetwork.name);
    if (network) {
        const existingSaslPass = network.sasl_pass || '';
        const saslSecret = existingSaslPass && existingSaslPass !== 'RELAYOS_BNC_SASL_UNPROVISIONED'
            ? existingSaslPass
            : generateRelayBncSaslSecret();

        network.nick = username;
        network.username = username;
        network.realname = username;
        network.sasl_account = username;
        network.sasl_pass = saslSecret;
        await network.save();
        await ensureRelayBncSaslCredential(app, wpUserId, saslSecret);
        return network;
    }

    const saslSecret = generateRelayBncSaslSecret();
    network = await app.userDb.addNetwork(userId, buildUserNetwork(defaultNetwork, username, saslSecret));
    await ensureRelayBncSaslCredential(app, wpUserId, saslSecret);
    return network;
}

async function ensureOAuthUser(app, identity, defaultNetwork) {
    const username = identity.username;
    let user = await app.userDb.getUser(username);
    if (!user) {
        user = await app.userDb.addUser(username, generateUnusablePassword(), false, {
            wp_user_id: identity.wpUserId,
        });
    } else if (!user.wp_user_id && typeof app.userDb.setUserWordPressId === 'function') {
        await app.userDb.setUserWordPressId(getUserId(user), identity.wpUserId);
        user.wp_user_id = identity.wpUserId;
    }

    await ensureDefaultNetwork(app, user, defaultNetwork, identity.wpUserId);

    return user;
}

async function isRelayBncLoginEntitled(app, identity, oauthConf) {
    const required = oauthConf.requiredEntitlements || DEFAULT_REQUIRED_ENTITLEMENTS;
    if (!required.length) {
        return true;
    }

    const resolver = new RelayosEntitlements({
        db: app && app.db && app.db.dbUsers,
        logger: global.l || console,
        tenantId: oauthConf.tenantId,
    });
    await resolver.init();
    const user = {
        username: identity.username,
        wp_user_id: identity.wpUserId,
    };
    const entitlements = typeof resolver.getEffectiveUserEntitlements === 'function'
        ? await resolver.getEffectiveUserEntitlements(user)
        : await resolver.getUserEntitlements(user);
    return entitlements.some((key) => required.includes(key));
}

async function ensureWordPressLinkage(app, defaultNetwork = buildDefaultNetwork({})) {
    return ensureBncWordPressProvisioning(app, defaultNetwork);
}

function registerRoutes(app) {
    const oauthConf = buildOauthConfig(app);

    if (!oauthConf) {
        l.info('OAuth config missing; skipping OAuth routes');
        return;
    }

    l.info('OAuth routes enabled', {
        authUrl: oauthConf.authUrl,
        tokenUrl: oauthConf.tokenUrl,
        redirect: oauthConf.redirectUri,
        userInfo: oauthConf.userInfoUrl,
    });

    const router = app.webserver.router;

    router.get('/oauth/login', async (ctx) => {
        const state = crypto.randomBytes(16).toString('hex');
        setStateCookie(ctx, state);

        const params = new URLSearchParams({
            response_type: 'code',
            client_id: oauthConf.clientId,
            redirect_uri: oauthConf.redirectUri,
            scope: oauthConf.scope,
            state,
        });

        const sep = oauthConf.authUrl.includes('?') ? '&' : '?';
        ctx.redirect(`${oauthConf.authUrl}${sep}${params.toString()}`);
    });

    router.get('/oauth/callback', async (ctx) => {
        const { code, state } = ctx.query;
        const cookieState = ctx.cookies.get('kiwibnc_oauth_state');

        if (!code || !state || !cookieState || cookieState !== state) {
            return respondError(ctx, 'OAuth state mismatch. Please try again.');
        }
        clearStateCookie(ctx);

        let tokenResp;
        try {
            tokenResp = await exchangeCodeForToken(oauthConf, code);
        } catch (err) {
            l.error('OAuth token exchange failed:', err.message);
            return respondError(ctx, 'OAuth token exchange failed.');
        }

        const accessToken = tokenResp.access_token;
        if (!accessToken) {
            return respondError(ctx, 'OAuth provider did not return an access token.');
        }

        let userInfo = Object.assign({}, tokenResp);
        try {
            const fetched = await fetchUserInfo(oauthConf, accessToken);
            userInfo = Object.assign(userInfo, fetched || {});
        } catch (err) {
            l.warn('OAuth userinfo fetch failed:', err.message);
        }

        const infoKeys = Object.keys(userInfo || {}).filter(k => k !== 'id_token' && k !== 'access_token' && k !== 'refresh_token');
        l.info('OAuth userinfo received', {
            keys: infoKeys,
            sample: {
                username: userInfo.username || userInfo.user_login || '',
                email: userInfo.email || '',
                preferred_username: userInfo.preferred_username || '',
            },
        });

        let mappedUser;
        try {
            const identity = resolveWordPressIdentity(userInfo);
            if (!(await isRelayBncLoginEntitled(app, identity, oauthConf))) {
                l.info('OAuth denied RelayBNC login for unentitled user', { username: identity.username });
                return renderBncUpgradeRedirectPage(ctx, oauthConf);
            }
            mappedUser = await ensureOAuthUser(app, identity, oauthConf.defaultNetwork);
        } catch (err) {
            l.warn('OAuth rejected login:', err.message);
            return respondError(ctx, err.message);
        }

        let token;
        try {
            token = await app.userDb.generateUserToken(getUserId(mappedUser), 7 * 24 * 3600, 'oauth-login', ctx.ip);
            l.info('OAuth issued token for user', { username: mappedUser.username });
        } catch (err) {
            l.error('OAuth token generation failed:', err.message);
            return respondError(ctx, 'Failed to generate login token.');
        }

        ctx.type = 'text/html';
        ctx.body = renderTokenPage(mappedUser.username, token, 7 * 24 * 3600);
    });

    return oauthConf;
}

function getClientConfig(oauthConf) {
    if (!oauthConf) {
        return null;
    }

    return {
        login_url: '/oauth/login',
        provider: oauthConf.provider || 'OAuth',
    };
}

module.exports = {
    registerRoutes,
    getClientConfig,
    buildOauthConfig,
    ensureBncWordPressProvisioning,
    ensureWordPressLinkage,
    __testHooks: {
        resolveWordPressIdentity,
        ensureOAuthUser,
        isRelayBncLoginEntitled,
        renderBncUpgradeRedirectPage,
        buildDefaultNetwork,
        generateRelayBncSaslSecret,
        ensureRelayBncSaslCredential,
        ensureBncWordPressProvisioning,
        ensureWordPressLinkage,
    },
};
