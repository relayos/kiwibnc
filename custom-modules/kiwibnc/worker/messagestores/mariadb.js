'use strict';

const mysql = require('mysql');
const Stats = require('../../libs/stats');
const Helpers = require('../../libs/helpers');
const IrcMessage = require('irc-framework').Message;

const MSG_TYPE_PRIVMSG = 1;
const MSG_TYPE_NOTICE = 2;
const DEFAULT_LIMIT = 50;
const DEFAULT_TABLE = 'bnc_messages';
// Contract defaults: tableName = 'bnc_messages'
// Schema contract: CREATE TABLE IF NOT EXISTS bnc_messages with FOREIGN KEY
// constraints that REFERENCES bnc_users and REFERENCES bnc_user_networks.

class MariaDbMessageStore {
    constructor(config) {
        this.supportsWrite = true;
        this.supportsRead = true;

        this.conf = config;
        this.stats = Stats.instance().makePrefix('messages');
        this.logger = global.l || console;

        const storeConf = config.get('message_store_mariadb', {});
        const databaseConf = config.get('database', {});
        const tablePrefix = storeConf.table_prefix || databaseConf.table_prefix || 'bnc_';
        this.messagesDsn = storeConf.messages_dsn || storeConf.dsn || storeConf.message_dsn || '';
        this.tableName = storeConf.tableName || storeConf.table || storeConf.messages_table || DEFAULT_TABLE;
        this.usersTable = storeConf.users_table || `${tablePrefix}users`;
        this.networksTable = storeConf.networks_table || `${tablePrefix}user_networks`;
        this.autoMigrate = storeConf.auto_migrate !== false;
        this.bufferNormalize = storeConf.buffer_normalize || 'lower';
        this.collation = storeConf.messages_collation || 'utf8mb4_unicode_520_ci';
        this.maxStatementTime = parseOptionalNumber(storeConf.max_statement_time);

        this.writeQueue = [];
        this.processingQueue = false;
    }

    async init() {
        if (!this.messagesDsn) {
            throw new Error('message_store_mariadb.messages_dsn is required');
        }

        this.validateIdentifier(this.tableName);
        this.validateIdentifier(this.usersTable);
        this.validateIdentifier(this.networksTable);
        this.validateIdentifier(this.collation);

        this.messagesPool = mysql.createPool(parseMysqlConnectionString(this.messagesDsn));
        this.applySessionOptions(this.messagesPool);
        this.messagesQuery = this.promisifyQuery(this.messagesPool);

        if (this.autoMigrate) {
            await this.migrateSchema();
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

    async migrateSchema() {
        await this.messagesQuery(`
            CREATE TABLE IF NOT EXISTS \`${this.tableName}\` (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                user_id INT UNSIGNED NOT NULL,
                network_id INT UNSIGNED NOT NULL,
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
                KEY idx_bnc_messages_user_buffer_time (user_id, network_id, buffer, time, id),
                KEY idx_bnc_messages_user_buffer_lower_time (user_id, network_id, buffer_lower, time, id),
                KEY idx_bnc_messages_msgid (msgid),
                CONSTRAINT fk_bnc_messages_user
                    FOREIGN KEY (user_id) REFERENCES \`${this.usersTable}\` (id)
                    ON DELETE CASCADE,
                CONSTRAINT fk_bnc_messages_network
                    FOREIGN KEY (network_id) REFERENCES \`${this.networksTable}\` (id)
                    ON DELETE CASCADE
            ) CHARACTER SET utf8mb4 COLLATE ${this.collation}
        `);
    }

    async getMessagesFromMsgId(userId, networkId, buffer, fromMsgId, length) {
        const boundary = await this.lookupMsgIdBoundary(userId, networkId, buffer, fromMsgId, 'ASC');
        if (!boundary) {
            return [];
        }

        const rows = await this.messagesQuery(
            `SELECT id, user_id, network_id, buffer, time, type, msgid, msgtags, params, data, prefix
             FROM \`${this.tableName}\`
             WHERE user_id = ? AND network_id = ? AND ${this.bufferQueryField()} = ?
               AND (time > ? OR (time = ? AND id > ?))
             ORDER BY time ASC, id ASC
             LIMIT ?`,
            [
                userId,
                networkId,
                this.normalizeBuffer(buffer),
                boundary.time,
                boundary.time,
                boundary.id,
                normalizeLimit(length),
            ]
        );

        return dbRowsToMessage(rows);
    }

    async getMessagesFromTime(userId, networkId, buffer, fromTime, length) {
        const rows = await this.messagesQuery(
            `SELECT id, user_id, network_id, buffer, time, type, msgid, msgtags, params, data, prefix
             FROM \`${this.tableName}\`
             WHERE user_id = ? AND network_id = ? AND ${this.bufferQueryField()} = ? AND time > ?
             ORDER BY time ASC, id ASC
             LIMIT ?`,
            [
                userId,
                networkId,
                this.normalizeBuffer(buffer),
                fromTime,
                normalizeLimit(length),
            ]
        );

        return dbRowsToMessage(rows);
    }

    async getMessagesBeforeMsgId(userId, networkId, buffer, msgId, length) {
        const boundary = await this.lookupMsgIdBoundary(userId, networkId, buffer, msgId, 'DESC');
        if (!boundary) {
            return [];
        }

        const rows = await this.messagesQuery(
            `SELECT id, user_id, network_id, buffer, time, type, msgid, msgtags, params, data, prefix
             FROM \`${this.tableName}\`
             WHERE user_id = ? AND network_id = ? AND ${this.bufferQueryField()} = ?
               AND (time < ? OR (time = ? AND id <= ?))
             ORDER BY time DESC, id DESC
             LIMIT ?`,
            [
                userId,
                networkId,
                this.normalizeBuffer(buffer),
                boundary.time,
                boundary.time,
                boundary.id,
                normalizeLimit(length),
            ]
        );

        rows.reverse();
        return dbRowsToMessage(rows);
    }

    async getMessagesBeforeTime(userId, networkId, buffer, beforeTime, length) {
        const rows = await this.messagesQuery(
            `SELECT id, user_id, network_id, buffer, time, type, msgid, msgtags, params, data, prefix
             FROM \`${this.tableName}\`
             WHERE user_id = ? AND network_id = ? AND ${this.bufferQueryField()} = ? AND time <= ?
             ORDER BY time DESC, id DESC
             LIMIT ?`,
            [
                userId,
                networkId,
                this.normalizeBuffer(buffer),
                beforeTime,
                normalizeLimit(length),
            ]
        );

        rows.reverse();
        return dbRowsToMessage(rows);
    }

    async getMessagesBetween(userId, networkId, buffer, from, to, length) {
        const fromBoundary = await this.resolveBoundaryRef(userId, networkId, buffer, from, 'ASC');
        const toBoundary = await this.resolveBoundaryRef(userId, networkId, buffer, to, 'DESC');
        if (!fromBoundary || !toBoundary) {
            return [];
        }

        const rows = await this.messagesQuery(
            `SELECT id, user_id, network_id, buffer, time, type, msgid, msgtags, params, data, prefix
             FROM \`${this.tableName}\`
             WHERE user_id = ? AND network_id = ? AND ${this.bufferQueryField()} = ?
               AND (time > ? OR (time = ? AND id >= ?))
               AND (time < ? OR (time = ? AND id < ?))
             ORDER BY time DESC, id DESC
             LIMIT ?`,
            [
                userId,
                networkId,
                this.normalizeBuffer(buffer),
                fromBoundary.time,
                fromBoundary.time,
                fromBoundary.id,
                toBoundary.time,
                toBoundary.time,
                toBoundary.id,
                normalizeLimit(length),
            ]
        );

        rows.reverse();
        return dbRowsToMessage(rows);
    }

    async storeMessage(message, upstreamCon, clientCon) {
        this.writeQueue.push({ message, upstreamCon, clientCon });
        this.processWriteQueue();
    }

    async processWriteQueue() {
        if (this.processingQueue) {
            return;
        }

        this.processingQueue = true;
        try {
            while (this.writeQueue.length) {
                const item = this.writeQueue.shift();
                try {
                    await this.writeMessage(item.message, item.upstreamCon, item.clientCon);
                } catch (err) {
                    this.logger.error('MariaDB message store write failed:', err && err.stack ? err.stack : err);
                }
            }
        } finally {
            this.processingQueue = false;
        }
    }

    async writeMessage(message, upstreamCon, clientCon) {
        if (!upstreamCon || !upstreamCon.state) {
            return;
        }

        const row = this.rowFromMessage(message, upstreamCon, clientCon);
        if (!row) {
            return;
        }

        const messagesTmr = this.stats.timerStart('store.time');
        try {
            await this.messagesQuery(
                `INSERT INTO \`${this.tableName}\`
                 (user_id, network_id, buffer, buffer_lower, time, type, msgid, msgtags, prefix, params, data)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    row.user_id,
                    row.network_id,
                    row.buffer,
                    row.buffer_lower,
                    row.time,
                    row.type,
                    row.msgid,
                    row.msgtags,
                    row.prefix,
                    row.params,
                    row.data,
                ]
            );
        } finally {
            messagesTmr.stop();
        }
    }

    rowFromMessage(message, upstreamCon, clientCon) {
        if (!message || !message.command || !message.params) {
            return null;
        }

        if (isIgnoredCtcp(message)) {
            return null;
        }

        let type = 0;
        if (message.command === 'PRIVMSG') {
            type = MSG_TYPE_PRIVMSG;
        } else if (message.command === 'NOTICE') {
            type = MSG_TYPE_NOTICE;
        }

        if (!type || !message.params[1]) {
            return null;
        }

        const bufferName = Helpers.extractBufferName(upstreamCon, message, 0) || '';
        const tags = message.tags || {};
        return {
            user_id: upstreamCon.state.authUserId,
            network_id: upstreamCon.state.authNetworkId,
            buffer: bufferName,
            buffer_lower: this.normalizeBuffer(bufferName),
            time: (new Date(tags.time || Helpers.isoTime())).getTime(),
            type,
            msgid: tags['draft/msgid'] || tags.msgid || '',
            msgtags: JSON.stringify(tags),
            prefix: message.prefix || (clientCon ? clientCon.state.nick : message.nick) || '',
            params: message.params.slice(0, message.params.length - 1).join(' '),
            data: message.params[1] || '',
        };
    }

    async resolveBoundaryRef(userId, networkId, buffer, ref, order) {
        if (!ref || !ref.type) {
            return null;
        }

        if (ref.type === 'timestamp') {
            return {
                time: ref.value,
                id: order === 'DESC' ? Number.MAX_SAFE_INTEGER : 0,
            };
        }

        if (ref.type === 'msgid') {
            return this.lookupMsgIdBoundary(userId, networkId, buffer, ref.value, order);
        }

        return null;
    }

    async lookupMsgIdBoundary(userId, networkId, buffer, msgId, order) {
        if (!msgId) {
            return null;
        }

        const sortOrder = order === 'DESC' ? 'DESC' : 'ASC';
        const rows = await this.messagesQuery(
            `SELECT id, time FROM \`${this.tableName}\`
             WHERE user_id = ? AND network_id = ? AND ${this.bufferQueryField()} = ? AND msgid = ?
             ORDER BY time ${sortOrder}, id ${sortOrder}
             LIMIT 1`,
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

        return {
            id: rows[0].id,
            time: rows[0].time,
        };
    }

    normalizeBuffer(buffer) {
        if (!buffer) {
            return '';
        }

        if (this.bufferNormalize === 'none') {
            return String(buffer);
        }

        return String(buffer).toLowerCase();
    }

    bufferQueryField() {
        return this.bufferNormalize === 'none' ? 'buffer' : 'buffer_lower';
    }

    validateIdentifier(name) {
        if (!/^[a-zA-Z0-9_]+$/.test(String(name || ''))) {
            throw new Error(`Invalid SQL identifier: ${name}`);
        }
    }

    promisifyQuery(pool) {
        return (sql, params) => new Promise((resolve, reject) => {
            pool.query(sql, params || [], (err, results) => {
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
module.exports.parseMysqlConnectionString = parseMysqlConnectionString;

function isIgnoredCtcp(message) {
    return (message.command === 'PRIVMSG' || message.command === 'NOTICE') &&
        message.params[1] &&
        message.params[1][0] === '\x01' &&
        !message.params[1].startsWith('\x01ACTION');
}

function normalizeLimit(length) {
    const limit = Number(length);
    return Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : DEFAULT_LIMIT;
}

function parseOptionalNumber(value) {
    if (value === undefined || value === null || value === '') {
        return undefined;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function decodeConnectionPart(value) {
    return decodeURIComponent(value.replace(/\+/g, '%20'));
}

function parseMysqlConnectionString(connectionString) {
    const scheme = connectionString.startsWith('mariadb://') ? 'mariadb://' : 'mysql://';
    const withoutScheme = connectionString.slice(scheme.length);
    const authEnd = withoutScheme.lastIndexOf('@');
    if (authEnd === -1) {
        throw new Error('Invalid mysql connection string: missing credentials');
    }

    const auth = withoutScheme.slice(0, authEnd);
    const hostPath = withoutScheme.slice(authEnd + 1);
    const userEnd = auth.indexOf(':');
    if (userEnd === -1) {
        throw new Error('Invalid mysql connection string: missing password');
    }

    const slash = hostPath.indexOf('/');
    const hostPort = slash === -1 ? hostPath : hostPath.slice(0, slash);
    const databaseAndQuery = slash === -1 ? '' : hostPath.slice(slash + 1);
    const queryStart = databaseAndQuery.indexOf('?');
    const database = queryStart === -1 ?
        databaseAndQuery :
        databaseAndQuery.slice(0, queryStart);
    const query = queryStart === -1 ? '' : databaseAndQuery.slice(queryStart + 1);

    let host = hostPort;
    let port;
    if (hostPort.startsWith('[')) {
        const hostEnd = hostPort.indexOf(']');
        host = hostEnd === -1 ? hostPort : hostPort.slice(1, hostEnd);
        if (hostEnd !== -1 && hostPort[hostEnd + 1] === ':') {
            port = Number(hostPort.slice(hostEnd + 2));
        }
    } else {
        const portStart = hostPort.lastIndexOf(':');
        if (portStart !== -1) {
            host = hostPort.slice(0, portStart);
            port = Number(hostPort.slice(portStart + 1));
        }
    }

    const connection = {
        host: decodeConnectionPart(host),
        user: decodeConnectionPart(auth.slice(0, userEnd)),
        password: decodeConnectionPart(auth.slice(userEnd + 1)),
        database: decodeConnectionPart(database),
    };
    if (port) {
        connection.port = port;
    }

    const params = new URLSearchParams(query);
    if (params.has('charset')) {
        connection.charset = params.get('charset');
    }

    return connection;
}

function dbRowsToMessage(rows) {
    return rows.map((row) => {
        const message = new IrcMessage();
        if (row.type === MSG_TYPE_PRIVMSG) {
            message.command = 'PRIVMSG';
        } else if (row.type === MSG_TYPE_NOTICE) {
            message.command = 'NOTICE';
        } else {
            message.command = 'PRIVMSG';
        }

        message.prefix = row.prefix || '';
        try {
            message.tags = JSON.parse(row.msgtags || '{}');
        } catch (err) {
            message.tags = {};
        }
        message.tags.time = message.tags.time || Helpers.isoTime(new Date(row.time));
        message.params = String(row.params || '').split(' ').filter((part) => part.length);
        message.params.push(row.data || '');

        return message;
    });
}
