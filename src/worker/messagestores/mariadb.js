const mysql = require('mysql');
const Stats = require('../../libs/stats');
const Helpers = require('../../libs/helpers');
const IrcMessage = require('irc-framework').Message;

const MSG_TYPE_PRIVMSG = 1;
const MSG_TYPE_NOTICE = 2;

const DEFAULT_LIMIT = 50;

/**
 * MariaDB message store with tier-based access control.
 *
 * TIER SYSTEM OVERVIEW:
 * ---------------------
 * Messages are stored for all users, but READ access can be limited by tier.
 * This enables a "freemium" model where users see they have history (via
 * Message History tab) but must upgrade to read older/more messages.
 *
 * Buffer list (httpapi recentbuffers):
 *   - Intentionally NOT limited by tier
 *   - Shows all conversations with message counts
 *   - Purpose: tease the value, encourage upgrades
 *   - See: extensions/httpapi/index.js
 *
 * Message list (CHATHISTORY):
 *   - LIMITED by tier via applyTierLimits()
 *   - max_days: clamp to recent messages only
 *   - max_messages: clamp messages per query
 *   - Purpose: gate the actual value, require upgrade
 *
 * Config example:
 *   [message_store_mariadb]
 *   roles = { free = { max_days = 90, max_messages = 200 }, pro = { max_days = 0, max_messages = 0 } }
 *   sku_roles = { "SKU_FREE" = "free", "SKU_PRO" = "pro" }
 *
 * The user's SKU is looked up from users_table.users_tier_field and mapped
 * to a role name via sku_roles, then role config is applied.
 */
class MariaDbMessageStore {
    constructor(config) {
        this.supportsWrite = true;
        this.supportsRead = true;

        this.conf = config;
        this.stats = Stats.instance().makePrefix('messages');

        const storeConf = config.get('message_store_mariadb', {});
        this.messagesDsn = storeConf.messages_dsn || storeConf.dsn || storeConf.message_dsn || '';
        this.usersDsn = storeConf.users_dsn || '';

        this.messagesTable = storeConf.messages_table || 'messages';
        this.usersTable = storeConf.users_table || 'users';
        this.usersIdField = storeConf.users_id_field || 'id';
        this.usersTierField = storeConf.users_tier_field || 'sku';
        this.maxStatementTime = typeof storeConf.max_statement_time === 'number' ? storeConf.max_statement_time : undefined;

        this.defaultRole = storeConf.default_role || 'default';
        this.roles = storeConf.roles || {};
        this.skuRoles = storeConf.sku_roles || {};

        this.tierCacheTtlMs = (storeConf.tier_cache_ttl_seconds || 300) * 1000;
        this.tierCache = new Map();

        this.autoMigrate = storeConf.auto_migrate !== false;
        this.bufferNormalize = storeConf.buffer_normalize || 'none';
        this.collation = storeConf.messages_collation || 'utf8mb4_unicode_ci';
    }

    async init() {
        if (!this.messagesDsn) {
            throw new Error('message_store_mariadb.messages_dsn is required');
        }
        this.messagesPool = mysql.createPool(this.messagesDsn);
        this.applySessionOptions(this.messagesPool);
        this.messagesQuery = this.promisifyQuery(this.messagesPool);

        if (this.usersDsn) {
            this.usersPool = mysql.createPool(this.usersDsn);
            this.applySessionOptions(this.usersPool);
            this.usersQuery = this.promisifyQuery(this.usersPool);
        } else {
            // Optionally reuse the messages DB for tier lookups
            this.usersPool = this.messagesPool;
            this.usersQuery = this.messagesQuery;
        }

        if (this.autoMigrate) {
            this.ensureSchema();
        }
    }

    applySessionOptions(pool) {
        if (typeof this.maxStatementTime !== 'number') {
            return;
        }
        pool.on('connection', (conn) => {
            conn.query('SET SESSION max_statement_time = ?', [this.maxStatementTime], () => {});
        });
    }

    async ensureSchema() {
        this.validateIdentifier(this.messagesTable);
        const sql = `
            CREATE TABLE IF NOT EXISTS \`${this.messagesTable}\` (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                user_id INT NOT NULL,
                network_id INT NOT NULL,
                buffer VARCHAR(200) NOT NULL,
                buffer_lower VARCHAR(200) NOT NULL,
                time BIGINT NOT NULL,
                type TINYINT NOT NULL,
                msgid VARCHAR(128) NULL,
                msgtags TEXT NOT NULL,
                prefix TEXT NOT NULL,
                params TEXT NOT NULL,
                data MEDIUMTEXT NOT NULL,
                PRIMARY KEY (id),
                KEY idx_user_buffer_time (user_id, network_id, buffer, time, id),
                KEY idx_user_buffer_lower_time (user_id, network_id, buffer_lower, time, id),
                KEY idx_msgid (msgid)
            ) CHARACTER SET utf8mb4 COLLATE ${this.collation}`;
        await this.messagesQuery(sql);
    }

    async getMessagesFromMsgId(userId, networkId, buffer, fromMsgId, length) {
        const msgTime = await this.lookupMsgIdTime(userId, networkId, buffer, fromMsgId);
        if (msgTime === null) {
            return [];
        }
        return this.getMessagesFromTime(userId, networkId, buffer, msgTime, length);
    }

    async getMessagesFromTime(userId, networkId, buffer, fromTime, length) {
        const limits = await this.applyTierLimits(userId, {
            fromTime,
            toTime: null,
            limit: length,
        });
        if (limits.empty) {
            return [];
        }

        const messagesTmr = this.stats.timerStart('lookup.time');
        const rows = await this.messagesQuery(
            `SELECT id, user_id, network_id, buffer, time, type, msgid, msgtags, params, data, prefix
             FROM \`${this.messagesTable}\`
             WHERE user_id = ? AND network_id = ? AND ${this.bufferQueryField()} = ? AND time >= ?
             ORDER BY time ASC, id ASC
             LIMIT ?`,
            [
                userId,
                networkId,
                this.normalizeBuffer(buffer),
                limits.fromTime,
                limits.limit,
            ]
        );
        const messages = dbRowsToMessage(rows);
        messagesTmr.stop();
        return messages;
    }

    async getMessagesBeforeMsgId(userId, networkId, buffer, msgId, length) {
        const msgTime = await this.lookupMsgIdTime(userId, networkId, buffer, msgId);
        if (msgTime === null) {
            return [];
        }
        return this.getMessagesBeforeTime(userId, networkId, buffer, msgTime, length);
    }

    async getMessagesBeforeTime(userId, networkId, buffer, beforeTime, length) {
        const limits = await this.applyTierLimits(userId, {
            fromTime: null,
            toTime: beforeTime,
            limit: length,
        });
        if (limits.empty) {
            return [];
        }

        const messagesTmr = this.stats.timerStart('lookup.time');
        const rows = await this.messagesQuery(
            `SELECT id, user_id, network_id, buffer, time, type, msgid, msgtags, params, data, prefix
             FROM \`${this.messagesTable}\`
             WHERE user_id = ? AND network_id = ? AND ${this.bufferQueryField()} = ? AND time <= ? AND time >= ?
             ORDER BY time DESC, id DESC
             LIMIT ?`,
            [
                userId,
                networkId,
                this.normalizeBuffer(buffer),
                limits.toTime,
                limits.fromTime,
                limits.limit,
            ]
        );
        rows.reverse();
        const messages = dbRowsToMessage(rows);
        messagesTmr.stop();
        return messages;
    }

    async getMessagesBetween(userId, networkId, buffer, from, to, length) {
        const fromTime = await this.resolveTimeRef(userId, networkId, buffer, from);
        const toTime = await this.resolveTimeRef(userId, networkId, buffer, to);
        if (fromTime === null || toTime === null) {
            return [];
        }

        const limits = await this.applyTierLimits(userId, {
            fromTime,
            toTime,
            limit: length,
        });
        if (limits.empty) {
            return [];
        }

        const messagesTmr = this.stats.timerStart('lookup.time');
        const rows = await this.messagesQuery(
            `SELECT id, user_id, network_id, buffer, time, type, msgid, msgtags, params, data, prefix
             FROM \`${this.messagesTable}\`
             WHERE user_id = ? AND network_id = ? AND ${this.bufferQueryField()} = ? AND time >= ? AND time < ?
             ORDER BY time DESC, id DESC
             LIMIT ?`,
            [
                userId,
                networkId,
                this.normalizeBuffer(buffer),
                limits.fromTime,
                limits.toTime,
                limits.limit,
            ]
        );
        rows.reverse();
        const messages = dbRowsToMessage(rows);
        messagesTmr.stop();
        return messages;
    }

    async storeMessage(message, upstreamCon, clientCon) {
        const conState = upstreamCon.state;
        const userId = conState.authUserId;
        const networkId = conState.authNetworkId;

        let bufferName = '';
        let type = 0;
        let data = '';
        let params = '';
        let msgId = '';
        let prefix = message.prefix || (clientCon ? clientCon.state.nick : message.nick);
        let time = new Date(message.tags.time || Helpers.isoTime());

        if (
            (message.command === 'PRIVMSG' || message.command === 'NOTICE') &&
            message.params[1] && message.params[1][0] === '\x01'
        ) {
            if (!message.params[1].startsWith('\x01ACTION')) {
                return;
            }
        }

        if (message.command === 'PRIVMSG') {
            type = MSG_TYPE_PRIVMSG;
            bufferName = Helpers.extractBufferName(upstreamCon, message, 0);
            data = message.params[1];
            params = message.params.slice(0, message.params.length - 1).join(' ');
            msgId = message.tags['draft/msgid'] || message.tags['msgid'] || '';
        } else if (message.command === 'NOTICE') {
            type = MSG_TYPE_NOTICE;
            bufferName = Helpers.extractBufferName(upstreamCon, message, 0);
            data = message.params[1];
            params = message.params.slice(0, message.params.length - 1).join(' ');
            msgId = message.tags['draft/msgid'] || message.tags['msgid'] || '';
        }

        if (!type) {
            return;
        }

        const messagesTmr = this.stats.timerStart('store.time');
        const normalizedBuffer = this.normalizeBuffer(bufferName);
        await this.messagesQuery(
            `INSERT INTO \`${this.messagesTable}\`
            (user_id, network_id, buffer, buffer_lower, time, type, msgid, msgtags, prefix, params, data)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                userId,
                networkId,
                bufferName || '',
                normalizedBuffer,
                time.getTime(),
                type,
                msgId,
                JSON.stringify(message.tags || {}),
                prefix || '',
                params || '',
                data || '',
            ]
        );
        messagesTmr.stop();
    }

    async resolveTimeRef(userId, networkId, buffer, ref) {
        if (!ref || !ref.type) {
            return null;
        }
        if (ref.type === 'timestamp') {
            return ref.value;
        }
        if (ref.type === 'msgid') {
            return this.lookupMsgIdTime(userId, networkId, buffer, ref.value);
        }
        return null;
    }

    async lookupMsgIdTime(userId, networkId, buffer, msgId) {
        if (!msgId) {
            return null;
        }
        const rows = await this.messagesQuery(
            `SELECT time FROM \`${this.messagesTable}\`
             WHERE user_id = ? AND network_id = ? AND ${this.bufferQueryField()} = ? AND msgid = ?
             ORDER BY time ASC, id ASC LIMIT 1`,
            [
                userId,
                networkId,
                this.normalizeBuffer(buffer),
                msgId,
            ]
        );
        if (!rows || !rows.length) {
            return null;
        }
        return rows[0].time;
    }

    /**
     * Apply tier-based limits to message queries (CHATHISTORY).
     *
     * This is the primary enforcement point for paid tier upgrades.
     * The buffer list (Message History tab) is intentionally NOT limited here -
     * showing users they have lots of history encourages upgrades.
     * Instead, we limit what they can READ within each conversation:
     *
     * TODO: Tier-based message limits for paid upgrades:
     * - max_days: "viewing messages older than Xmo requires an upgrade"
     *   Clamps fromTime to only allow recent messages.
     * - max_messages: "viewing more than X messages in this conversation requires an upgrade"
     *   Clamps limit per query (affects pagination depth).
     *
     * Example config:
     *   roles = {
     *     free = { max_days = 90, max_messages = 200 },
     *     pro = { max_days = 0, max_messages = 0 }  // 0 = unlimited
     *   }
     *
     * TODO: Consider adding response metadata to inform client of limits,
     * e.g. { clamped: true, upgrade_reason: 'max_days' } so UI can show
     * "Upgrade to view older messages" prompt.
     */
    async applyTierLimits(userId, params) {
        const limit = Number.isFinite(params.limit) && params.limit > 0 ? params.limit : DEFAULT_LIMIT;
        const tier = await this.getTierConfig(userId);

        let maxMessages = parseInt(tier.max_messages || 0, 10);
        let maxDays = parseInt(tier.max_days || 0, 10);

        let out = {
            fromTime: params.fromTime,
            toTime: params.toTime,
            limit: limit,
            empty: false,
            // TODO: Add these fields when implementing upgrade prompts:
            // clamped: false,
            // clampedBy: null,  // 'max_days' | 'max_messages'
        };

        // TODO: max_messages limit - "viewing more than X messages requires upgrade"
        if (maxMessages > 0) {
            out.limit = Math.min(out.limit, maxMessages);
            // out.clamped = out.clamped || (limit > maxMessages);
            // out.clampedBy = 'max_messages';
        }

        // TODO: max_days limit - "viewing messages older than X days requires upgrade"
        if (maxDays > 0) {
            const earliest = Date.now() - (maxDays * 24 * 60 * 60 * 1000);
            if (out.fromTime === null || out.fromTime < earliest) {
                out.fromTime = earliest;
                // out.clamped = true;
                // out.clampedBy = 'max_days';
            }
            if (out.toTime !== null && out.toTime < earliest) {
                out.empty = true;
            }
        }

        if (out.toTime === null) {
            out.toTime = Date.now();
        }
        if (out.fromTime === null) {
            out.fromTime = 0;
        }

        return out;
    }

    async getTierConfig(userId) {
        const cached = this.tierCache.get(userId);
        const now = Date.now();
        if (cached && cached.expiresAt > now) {
            return cached.roleConfig;
        }

        let roleName = this.defaultRole;
        if (this.usersQuery) {
            try {
                this.validateIdentifier(this.usersTable);
                this.validateIdentifier(this.usersIdField);
                this.validateIdentifier(this.usersTierField);
                const rows = await this.usersQuery(
                    `SELECT \`${this.usersTierField}\` AS sku FROM \`${this.usersTable}\` WHERE \`${this.usersIdField}\` = ? LIMIT 1`,
                    [userId]
                );
                if (rows && rows.length && rows[0].sku) {
                    const sku = String(rows[0].sku);
                    roleName = this.skuRoles[sku] || roleName;
                }
            } catch (err) {
                // Fall back to defaults if tier lookup fails
            }
        }

        const roleConfig = this.roles[roleName] || {};
        this.tierCache.set(userId, {
            roleConfig,
            expiresAt: now + this.tierCacheTtlMs,
        });
        return roleConfig;
    }

    normalizeBuffer(buffer) {
        if (!buffer) {
            return buffer;
        }
        if (this.bufferNormalize === 'lower') {
            return String(buffer).toLowerCase();
        }
        if (this.bufferNormalize === 'alnum') {
            return String(buffer).toLowerCase().replace(/[^a-z0-9#]/g, '');
        }
        return String(buffer);
    }

    bufferQueryField() {
        if (this.bufferNormalize === 'none') {
            return 'buffer';
        }
        return 'buffer_lower';
    }

    validateIdentifier(name) {
        if (!/^[a-zA-Z0-9_]+$/.test(String(name || ''))) {
            throw new Error(`Invalid SQL identifier: ${name}`);
        }
    }

    promisifyQuery(pool) {
        return (sql, params) => new Promise((resolve, reject) => {
            pool.query(sql, params, (err, results) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(results);
            });
        });
    }
}

module.exports = MariaDbMessageStore;

function dbRowsToMessage(rows) {
    return rows.map((row) => {
        let m = new IrcMessage();
        if (row.type === MSG_TYPE_PRIVMSG) {
            m.command = 'PRIVMSG';
        } else if (row.type === MSG_TYPE_NOTICE) {
            m.command = 'NOTICE';
        } else {
            m.command = 'PRIVMSG';
        }

        m.prefix = row.prefix || '';
        try {
            m.tags = JSON.parse(row.msgtags || '{}');
        } catch (err) {
            m.tags = {};
        }
        m.tags.time = m.tags.time || Helpers.isoTime(new Date(row.time));
        m.params = String(row.params || '').split(' ').filter(p => p.length);
        m.params.push(row.data || '');

        return m;
    });
}
