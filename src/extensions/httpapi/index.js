/**
 * Adds a /httpapi endpoint to the webserver
 *
 * Clients know if it is available via a 'kiwibnc/httpapi' supports token.
 * Requests must include a "Authorization: Bearer token" header where the token is a user token
 *
 * Example requests:
 * /httpapi?command=sendmessage&networkid=1&target=%23channel&message=a+reply+to+your+message
 * /httpapi?command=recentbuffers&limit=20&offset=0&days=90
 * /httpapi?command=logout
 */

const mysql = require('mysql');

module.exports.init = async function init(hooks, app) {
    hooks.on('available_isupports', async event => {
        event.tokens.push('kiwibnc/httpapi');
    });

    app.webserver.router.get('/httpapi', async ctx => {
        // Authorization: Bearer token1234
        let token = (ctx.headers['authorization'] || '').split(' ')[1]
        if (!token) {
            ctx.response.status = 401;
            return;
        }

        let user = await app.userDb.authUserToken(token, ctx.ip);
        if (!user) {
            ctx.response.status = 401;
            return;
        }

        let command = (ctx.query.command || '').replace(/[^a-z_]/ig, '');
        let args = Object.assign({}, ctx.query);
        delete args.command;

        if (!command || !apiCommands[command]) {
            ctx.body = {
                error: {
                    code: 'unknown_command',
                    message: 'This an unknown command',
                    command,
                },
            };
            return;
        }

        try {
            let result = await apiCommands[command](args, {
                user,
                hooks,
                app,
                token,
                webCtx: ctx,
            });
            ctx.body = {
                error: null,
                result: result || true,
            };
        } catch (err) {
            if (err instanceof CommandError) {
                // An error thrown from the command itself
                ctx.body = {
                    error: {
                        code: err.code,
                        message: err.message,
                    },
                };
                ctx.response.status = 500;
            } else {
                // An unexpected error
                l.error(`HTTPAPI error with command '${command}':`, err.stack);

                ctx.body = {
                    error: {
                        code: 'internal_error',
                        message: 'An error occured running the command',
                        command,
                    },
                };
                ctx.response.status = 500;
            }
        }
    });
};

class CommandError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
      this.name = 'CommandError';
    }
  }

const apiCommands = Object.create(null);
let messagesPool = null;

function getMessagesPool(app) {
    if (messagesPool) {
        return messagesPool;
    }

    const storeConf = app.conf.get('message_store_mariadb', {});
    const dsn = storeConf.messages_dsn || storeConf.dsn || storeConf.message_dsn || '';
    if (!dsn) {
        return null;
    }

    const url = new URL(dsn);
    messagesPool = mysql.createPool({
        host: url.hostname,
        port: url.port || 3306,
        user: decodeURIComponent(url.username || ''),
        password: decodeURIComponent(url.password || ''),
        database: url.pathname.replace(/^\//, ''),
    });
    return messagesPool;
}

function query(pool, sql, params = []) {
    return new Promise((resolve, reject) => {
        pool.query(sql, params, (err, rows) => {
            if (err) {
                reject(err);
                return;
            }
            resolve(rows);
        });
    });
}

apiCommands.logout = async (args, {user, app, token, hooks}) => {
    await app.userDb.removeUserToken(user.id, token);
    await hooks.emit('httpapi_command_logout', { user, token, args })
    return { loggedout: true };
};

apiCommands.sendmessage = async (args, {user, app, token, hooks}) => {
    if (!args.networkid || !args.target || !args.message) {
        throw new CommandError('missing_args', 'A target and message must be provided');
    }

    let con = app.cons.findUsersOutgoingConnection(user.id, parseInt(args.networkid, 10));
    if (!con) {
        throw new CommandError('network_not_found', 'The network was not found or is not connected');
    }

    if (!con.state.netRegistered) {
        throw new CommandError('network_disconnected', 'The network is not connected');
    }

    con.writeLine('PRIVMSG', args.target, args.message);
    return { sent: true };
};

apiCommands.messages = async (args, {user, app}) => {
    const pool = getMessagesPool(app);
    if (!pool) {
        throw new CommandError('no_messages_store', 'Messages store not configured');
    }

    const buffer = (args.buffer || '').trim();
    if (!buffer) {
        throw new CommandError('missing_buffer', 'Buffer name is required');
    }

    const limit = Math.min(Math.max(parseInt(args.limit || '50', 10) || 50, 1), 200);
    const before = args.before ? parseInt(args.before, 10) : null;

    // Query messages for this buffer
    // type: 1=PRIVMSG, 2=NOTICE
    // prefix format: "nick!user@host"
    // TODO: tier-based limits can be added here for paid upgrade feature
    let sql = `SELECT time, type, prefix, data
         FROM messages
         WHERE user_id = ? AND buffer_lower = LOWER(?)`;
    const params = [user.id, buffer];

    if (before) {
        sql += ` AND time < ?`;
        params.push(before);
    }

    sql += ` ORDER BY time DESC LIMIT ?`;
    params.push(limit);

    const rows = await query(pool, sql, params);

    // Parse prefix to extract nick, transform type to string
    const messages = rows.map(row => {
        const prefixMatch = (row.prefix || '').match(/^([^!]+)/);
        const nick = prefixMatch ? prefixMatch[1] : '';
        return {
            time: row.time,
            type: row.type === 1 ? 'privmsg' : row.type === 2 ? 'notice' : 'unknown',
            nick: nick,
            message: row.data || '',
        };
    });

    // Return in chronological order (oldest first)
    return { messages: messages.reverse(), meta: { buffer, limit, before } };
};

apiCommands.recentbuffers = async (args, {user, app}) => {
    const pool = getMessagesPool(app);
    if (!pool) {
        throw new CommandError('no_messages_store', 'Messages store not configured');
    }

    const storeConf = app.conf.get('message_store_mariadb', {});
    const defaultDays = parseInt(storeConf.recentbuffers_days, 10) || 90;
    const defaultLimit = parseInt(storeConf.recentbuffers_limit, 10) || 20;

    const search = (args.search || '').trim().toLowerCase();
    // When searching, don't apply days limit - search full history
    // Days limit only applies to "recent buffers" browsing (no search term)
    const days = search ? 0 : Math.max(parseInt(args.days || defaultDays, 10) || defaultDays, 1);
    const limit = Math.min(Math.max(parseInt(args.limit || defaultLimit, 10) || defaultLimit, 1), 200);
    const offset = Math.max(parseInt(args.offset || '0', 10) || 0, 0);

    // Build query
    // TODO: tier-based limits can be added here for paid upgrade feature
    let sql = `SELECT buffer, buffer_lower, MAX(time) AS last_time, COUNT(*) AS message_count
         FROM messages
         WHERE user_id = ?`;
    const params = [user.id];

    // Only apply time filter when not searching (browsing recent buffers)
    if (days > 0) {
        const since = Date.now() - (days * 24 * 60 * 60 * 1000);
        sql += ` AND time >= ?`;
        params.push(since);
    }

    if (search) {
        // Search on LOWER(buffer) for reliability - buffer_lower may have different normalization
        sql += ` AND LOWER(buffer) LIKE ?`;
        params.push('%' + search + '%');
    }

    sql += ` GROUP BY buffer, buffer_lower
         ORDER BY last_time DESC
         LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = await query(pool, sql, params);

    return { buffers: rows, meta: { limit, offset, days: days || 'all', search: search || undefined } };
};
