const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { URL, URLSearchParams } = require('url');
const createLogger = require('../../libs/logger');
const Helpers = require('../../libs/helpers');
const l = createLogger('webchat-oauth');

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

function resolveWordPressIdentity(userInfo) {
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

function buildUserNetwork(defaultNetwork, username) {
    return {
        name: defaultNetwork.name,
        host: defaultNetwork.host,
        port: defaultNetwork.port,
        tls: defaultNetwork.tls,
        nick: username,
        username,
        realname: username,
        channels: defaultNetwork.channels || '',
    };
}

function getUserId(user) {
    if (user && user.id && typeof user.id === 'object' && Object.prototype.hasOwnProperty.call(user.id, 'id')) {
        return user.id.id;
    }

    return user ? user.id : undefined;
}

function quotedIdentifier(knex, name) {
    return knex.client.wrapIdentifier(name, (value) => `\`${value.replace(/`/g, '``')}\``);
}

function unquotedIdentifier(knex, name) {
    return quotedIdentifier(knex, name).replace(/^`|`$/g, '').replace(/``/g, '`');
}

function quoteConstraint(name) {
    return `\`${name.replace(/`/g, '``')}\``;
}

async function addUserChildForeignKey(knex, tableName) {
    const usersTableName = unquotedIdentifier(knex, 'users');
    const childTableName = unquotedIdentifier(knex, tableName);
    const childTable = quotedIdentifier(knex, tableName);
    const usersTable = quotedIdentifier(knex, 'users');
    const constraintName = `${childTableName}_user_id_fk`;

    await knex.raw(
        `DELETE child
           FROM ${childTable} child
           LEFT JOIN ${usersTable} users ON users.id = child.user_id
          WHERE child.user_id IS NULL OR users.id IS NULL`
    );

    await knex.raw(`ALTER TABLE ${childTable} MODIFY COLUMN user_id INT(10) UNSIGNED NOT NULL`);

    const constraints = await knex.raw(
        `SELECT CONSTRAINT_NAME
           FROM information_schema.KEY_COLUMN_USAGE
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = ?
            AND COLUMN_NAME = 'user_id'
            AND REFERENCED_TABLE_NAME = ?
            AND REFERENCED_COLUMN_NAME = 'id'`,
        [childTableName, usersTableName]
    );
    const rows = Array.isArray(constraints) ? constraints[0] : constraints.rows;
    if (rows && rows.length) {
        return;
    }

    await knex.raw(
        `ALTER TABLE ${childTable}
          ADD CONSTRAINT ${quoteConstraint(constraintName)}
          FOREIGN KEY (user_id)
          REFERENCES ${usersTable} (id)
          ON DELETE CASCADE
          ON UPDATE CASCADE`
    );
}

async function ensureWordPressLinkage(app) {
    const knex = app.db && app.db.dbUsers;
    if (!knex || !knex.schema) {
        return;
    }

    const hasColumn = await knex.schema.hasColumn('users', 'wp_user_id');
    if (!hasColumn) {
        await knex.schema.table('users', function (table) {
            table.bigInteger('wp_user_id').unsigned().nullable().index();
        });
    }

    if (knex.client.config.client !== 'mysql') {
        return;
    }

    const usersTable = quotedIdentifier(knex, 'users');
    const usersTableName = unquotedIdentifier(knex, 'users');
    await knex.raw(`ALTER TABLE ${usersTable} MODIFY COLUMN wp_user_id BIGINT(20) UNSIGNED NULL`);
    await knex.raw(
        `UPDATE ${usersTable} bnc
            JOIN wp_users wp ON LOWER(wp.user_login) = LOWER(bnc.username)
           SET bnc.wp_user_id = wp.ID
         WHERE bnc.wp_user_id IS NULL`
    );

    const constraints = await knex.raw(
        `SELECT CONSTRAINT_NAME
           FROM information_schema.KEY_COLUMN_USAGE
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = ?
            AND COLUMN_NAME = 'wp_user_id'
            AND REFERENCED_TABLE_NAME = 'wp_users'`,
        [usersTableName]
    );
    const rows = Array.isArray(constraints) ? constraints[0] : constraints.rows;
    if (!rows || !rows.length) {
        await knex.schema.table('users', function (table) {
            table.foreign('wp_user_id')
                .references('ID')
                .inTable('wp_users')
                .onDelete('CASCADE')
                .onUpdate('CASCADE');
        });
    }

    await addUserChildForeignKey(knex, 'user_networks');
    await addUserChildForeignKey(knex, 'user_tokens');
}

async function getWordPressUserId(app, userId) {
    const row = await app.db.dbUsers('users')
        .select('wp_user_id')
        .where('id', userId)
        .first();
    return row ? row.wp_user_id : null;
}

async function setWordPressUserId(app, userId, wpUserId) {
    await app.db.dbUsers('users')
        .where('id', userId)
        .update({ wp_user_id: wpUserId });
}

async function ensureDefaultNetwork(app, user, defaultNetwork) {
    const userId = getUserId(user);
    const existing = await app.userDb.getNetworkByName(userId, defaultNetwork.name);
    if (existing) {
        return;
    }

    await app.userDb.addNetwork(userId, buildUserNetwork(defaultNetwork, user.username));
}

async function ensureOAuthUser(app, identity, defaultNetwork) {
    const username = identity.username;
    let user = await app.userDb.getUser(username);
    if (!user) {
        user = await app.userDb.addUser(username, generateUnusablePassword(), false);
        await setWordPressUserId(app, getUserId(user), identity.wpUserId);
    } else if (!await getWordPressUserId(app, getUserId(user))) {
        await setWordPressUserId(app, getUserId(user), identity.wpUserId);
    }

    await ensureDefaultNetwork(app, user, defaultNetwork);

    return user;
}

function registerRoutes(app, oauthConf = null) {
    oauthConf = oauthConf || buildOauthConfig(app);

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
    ensureWordPressLinkage,
    __testHooks: {
        resolveWordPressIdentity,
        ensureOAuthUser,
        ensureWordPressLinkage,
        buildDefaultNetwork,
    },
};
