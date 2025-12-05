const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { URL, URLSearchParams } = require('url');
const Helpers = require('../../libs/helpers');

function buildOauthConfig(app) {
    // Prefer explicit env vars; fall back to webchat config entries
    const webchat = app.conf.get('webchat') || {};
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
        provider: 'WordPress',
        allowRegistration: app.conf.get('webchat.public_register', false),
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

function decodeIdToken(idToken) {
    if (!idToken || typeof idToken !== 'string') {
        return null;
    }
    const parts = idToken.split('.');
    if (parts.length < 2) {
        return null;
    }
    try {
        const payload = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        return JSON.parse(payload);
    } catch (err) {
        return null;
    }
}

function pickUsername(source) {
    const candidates = [
        source.username,
        source.user_login,
        source.user_nicename,
        source.preferred_username,
        source.login,
        source.email && source.email.split('@')[0],
        source.name,
    ].filter(Boolean);

    return candidates[0] || '';
}

function sanitizeUsername(rawName) {
    let username = (rawName || '').trim();
    username = username.replace(/[^0-9a-zA-Z_-]/g, '');
    if (/^[0-9-]/.test(username)) {
        username = `u_${username}`;
    }
    return username;
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

        if ((!userInfo || Object.keys(userInfo).length === 0) && tokenResp.id_token) {
            const decoded = decodeIdToken(tokenResp.id_token);
            if (decoded) {
                userInfo = Object.assign({}, userInfo, decoded);
            }
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

        let username = sanitizeUsername(pickUsername(userInfo));
        if (!username || !Helpers.validUsername(username)) {
            return respondError(ctx, 'Unable to derive a valid username from OAuth provider.');
        }

        let user = await app.userDb.getUser(username);
        if (!user) {
            if (!oauthConf.allowRegistration) {
                return respondError(ctx, 'Account does not exist. Please contact an admin.');
            }

            const randomPass = crypto.randomBytes(12).toString('hex');
            try {
                user = await app.userDb.addUser(username, randomPass, false);
                l.info('OAuth created user', { username });
            } catch (err) {
                l.error('OAuth user creation failed:', err.message);
                return respondError(ctx, 'Failed to create account.');
            }
        }

        let token;
        try {
            token = await app.userDb.generateUserToken(user.id, 7 * 24 * 3600, 'oauth-login', ctx.ip);
            l.info('OAuth issued token for user', { username: user.username });
        } catch (err) {
            l.error('OAuth token generation failed:', err.message);
            return respondError(ctx, 'Failed to generate login token.');
        }

        ctx.type = 'text/html';
        ctx.body = renderTokenPage(username, token, 7 * 24 * 3600);
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
};
