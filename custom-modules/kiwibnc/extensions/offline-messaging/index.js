'use strict';

const { mParam } = require('../../libs/helpers');
const msgIdGenerator = require('../../libs/msgIdGenerator');

const DEFAULT_NETWORK_NAME = 'RelayOS';
const CHANNEL_PREFIXES = new Set(['#', '&', '+', '!']);

let logger = null;

module.exports.init = async function init(hooks, app) {
    logger = global.l || console;
    hooks.on('message_from_client', async event => handleMessageFromClient(event, app));
};

async function handleMessageFromClient(event, app) {
    const msg = event.message;
    const con = event.client;
    if (!msg || !msg.params || !msg.command || event.message.command.toUpperCase() !== 'PRIVMSG') {
        return;
    }

    const target = mParam(msg, 0, '').trim();
    const text = mParam(msg, 1, '');
    if (!target || !text || isChannelTarget(target) || target.toLowerCase() === '*bnc') {
        return;
    }

    const senderUsername = await senderCanonicalUsername(con, app);
    if (!senderUsername || target.toLowerCase() === senderUsername.toLowerCase()) {
        return;
    }

    const recipient = await lookupRecipient(app, target, con);
    if (!recipient) {
        return;
    }

    if (isRecipientOnline(app, recipient)) {
        return;
    }

    event.preventDefault();
    event.passthru = false;

    try {
        const store = findOfflineMessageStore(app, con);
        const msgid = msgIdGenerator.generateId();
        const stored = store && await store.storeOfflineDirectMessage({
            recipientUserId: recipient.user_id,
            recipientNetworkId: recipient.network_id,
            senderUsername,
            targetUsername: recipient.username,
            text,
            tags: Object.assign({}, msg.tags || {}, { msgid }),
            msgid,
        });

        if (!stored) {
            throw new Error('No configured message store supports offline direct messages');
        }

        sendNotice(con, `queued offline message for ${recipient.username}`);
    } catch (err) {
        logger.error('Failed to queue offline direct message:', err && err.stack ? err.stack : err);
        sendNotice(con, `failed to queue offline message for ${target}`);
    }
}

function isChannelTarget(target) {
    return CHANNEL_PREFIXES.has(target[0]);
}

async function senderCanonicalUsername(con, app) {
    const db = userDatabase(app, con);
    const state = con && con.state;
    const userId = state && state.authUserId;
    const networkId = state && state.authNetworkId;
    if (!db || !userId || !networkId) {
        return '';
    }

    const row = await db.dbUsers('users')
        .where('id', userId)
        .select('username')
        .first();

    return row && row.username ? row.username : '';
}

async function lookupRecipient(app, target, con) {
    const db = userDatabase(app, con);
    if (!db) {
        return null;
    }

    const row = await db.dbUsers('user_networks')
        .innerJoin('users', 'users.id', 'user_networks.user_id')
        .whereRaw('LOWER(users.username) = LOWER(?)', [target])
        .whereNotNull('users.wp_user_id')
        .where('user_networks.name', DEFAULT_NETWORK_NAME)
        .select(
            'users.id as user_id',
            'users.username',
            'users.wp_user_id',
            'user_networks.id as network_id',
            'user_networks.name as network_name'
        )
        .first();

    if (!row || !row.wp_user_id || row.network_name !== DEFAULT_NETWORK_NAME) {
        return null;
    }

    return row;
}

function isRecipientOnline(app, recipient) {
    if (!app || !app.cons || typeof app.cons.findUsersOutgoingConnection !== 'function') {
        return false;
    }

    const upstream = app.cons.findUsersOutgoingConnection(recipient.user_id, recipient.network_id);
    return !!(upstream && upstream.state && upstream.state.connected);
}

function findOfflineMessageStore(app, con) {
    const messages = (con && con.messages) || (app && app.messages);
    if (!messages) {
        return null;
    }

    if (typeof messages.storeOfflineDirectMessage === 'function') {
        return messages;
    }

    if (Array.isArray(messages.stores)) {
        return messages.stores.find(store => typeof store.storeOfflineDirectMessage === 'function') || null;
    }

    return null;
}

function userDatabase(app, con) {
    return (app && app.db) || (con && con.db) || null;
}

function sendNotice(con, text) {
    const target = con && con.state && con.state.nick ? con.state.nick : '*';
    if (con && typeof con.writeMsgFrom === 'function') {
        con.writeMsgFrom('*bnc', 'NOTICE', target, text);
    } else if (con && typeof con.writeStatus === 'function') {
        con.writeStatus(text);
    }
}

module.exports.handleMessageFromClient = handleMessageFromClient;
