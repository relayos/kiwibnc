'use strict';

const fs = require('fs');

const DEFAULT_TABLES = Object.freeze({
    capabilities: 'relayos_capabilities',
    entitlements: 'relayos_entitlements',
    entitlementCapabilities: 'relayos_entitlement_capabilities',
    userEntitlements: 'relayos_user_entitlements',
    wpUsers: 'wp_users',
});

const DEFAULT_ENTITLEMENTS = Object.freeze({
    'active-subscriber': Object.freeze([
        'async_message.send_to_offline',
        'async_message.receive_from_anyone',
    ]),
    'early-supporter': Object.freeze([
        'async_message.receive_from_anyone',
    ]),
    lucky: Object.freeze([]),
});

class RelayosEntitlements {
    constructor(options) {
        options = options || {};

        this.db = options.db || null;
        this.env = options.env || process.env;
        this.tables = Object.assign({}, DEFAULT_TABLES, options.tables || {});
        this.overlayPath = options.overlayPath || this.env.RELAYOS_ENTITLEMENTS_OVERLAY || '';
        this.logger = options.logger || console;
        this.overlayUsers = Object.create(null);
    }

    async init() {
        if (this.db) {
            await this.migrateSchema();
            await this.seedDefaults();
        }

        this.overlayUsers = this.loadOverlay();
    }

    async migrateSchema() {
        if (!this.db) {
            return;
        }

        Object.keys(this.tables).forEach((key) => validateIdentifier(this.tables[key]));

        const capabilities = quotedIdentifier(this.tables.capabilities);
        const entitlements = quotedIdentifier(this.tables.entitlements);
        const entitlementCapabilities = quotedIdentifier(this.tables.entitlementCapabilities);
        const userEntitlements = quotedIdentifier(this.tables.userEntitlements);
        const wpUsers = quotedIdentifier(this.tables.wpUsers);

        await this.db.raw(`
            CREATE TABLE IF NOT EXISTS ${capabilities} (
                \`key\` VARCHAR(191) NOT NULL,
                description TEXT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (\`key\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci
        `);

        await this.db.raw(`
            CREATE TABLE IF NOT EXISTS ${entitlements} (
                \`key\` VARCHAR(191) NOT NULL,
                description TEXT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (\`key\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci
        `);

        await this.db.raw(`
            CREATE TABLE IF NOT EXISTS ${entitlementCapabilities} (
                entitlement_key VARCHAR(191) NOT NULL,
                capability_key VARCHAR(191) NOT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (entitlement_key, capability_key),
                CONSTRAINT fk_relayos_entitlement_capabilities_entitlement
                    FOREIGN KEY (entitlement_key) REFERENCES ${entitlements} (\`key\`)
                    ON DELETE CASCADE,
                CONSTRAINT fk_relayos_entitlement_capabilities_capability
                    FOREIGN KEY (capability_key) REFERENCES ${capabilities} (\`key\`)
                    ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci
        `);

        await this.db.raw(`
            CREATE TABLE IF NOT EXISTS ${userEntitlements} (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                wp_user_id BIGINT UNSIGNED NOT NULL,
                entitlement_key VARCHAR(191) NOT NULL,
                status VARCHAR(32) NOT NULL DEFAULT 'active',
                starts_at DATETIME NULL,
                expires_at DATETIME NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                UNIQUE KEY uniq_relayos_user_entitlement (wp_user_id, entitlement_key),
                KEY idx_relayos_user_entitlements_active (wp_user_id, status, starts_at, expires_at),
                CONSTRAINT fk_relayos_user_entitlements_wp_user
                    FOREIGN KEY (\`wp_user_id\`) REFERENCES ${wpUsers} (\`ID\`)
                    ON DELETE CASCADE,
                CONSTRAINT fk_relayos_user_entitlements_entitlement
                    FOREIGN KEY (entitlement_key) REFERENCES ${entitlements} (\`key\`)
                    ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci
        `);
    }

    async seedDefaults() {
        if (!this.db) {
            return;
        }

        const entitlementKeys = Object.keys(DEFAULT_ENTITLEMENTS);
        const capabilityKeys = sorted(Array.from(new Set(
            entitlementKeys.reduce((all, key) => all.concat(DEFAULT_ENTITLEMENTS[key]), [])
        )));

        for (const key of entitlementKeys) {
            await this.insertIgnore(this.tables.entitlements, {
                key,
                description: `Default RelayOS entitlement: ${key}`,
            });
        }

        for (const key of capabilityKeys) {
            await this.insertIgnore(this.tables.capabilities, {
                key,
                description: `Default RelayOS capability: ${key}`,
            });
        }

        for (const entitlementKey of entitlementKeys) {
            for (const capabilityKey of DEFAULT_ENTITLEMENTS[entitlementKey]) {
                await this.insertIgnore(this.tables.entitlementCapabilities, {
                    entitlement_key: entitlementKey,
                    capability_key: capabilityKey,
                });
            }
        }
    }

    async insertIgnore(table, row) {
        validateIdentifier(table);

        const columns = Object.keys(row);
        const placeholders = columns.map(() => '?').join(', ');
        const bindings = columns.map((column) => row[column]);
        await this.db.raw(
            `INSERT IGNORE INTO ${quotedIdentifier(table)} (${columns.map(quotedIdentifier).join(', ')}) VALUES (${placeholders})`,
            bindings
        );
    }

    loadOverlay() {
        if (!this.overlayPath || !fs.existsSync(this.overlayPath)) {
            return Object.create(null);
        }

        return parseOverlay(fs.readFileSync(this.overlayPath, 'utf8')).users;
    }

    async getUserEntitlements(user) {
        user = user || {};

        const granted = new Set();
        const username = normalizeUsername(user.username);
        if (username && this.overlayUsers[username]) {
            this.overlayUsers[username].forEach((key) => granted.add(key));
        }

        if (this.db && user.wp_user_id !== undefined && user.wp_user_id !== null) {
            const rows = rowsFromRaw(await this.db.raw(
                `SELECT entitlement_key AS \`key\`
                 FROM ${quotedIdentifier(this.tables.userEntitlements)}
                 WHERE wp_user_id = ?
                   AND status = 'active'
                   AND (starts_at IS NULL OR starts_at <= ?)
                   AND (expires_at IS NULL OR expires_at > ?)`,
                [user.wp_user_id, new Date(), new Date()]
            ));

            rows.forEach((row) => {
                if (row.key || row.entitlement_key) {
                    granted.add(row.key || row.entitlement_key);
                }
            });
        }

        return sorted(Array.from(granted));
    }

    async getUserCapabilities(user) {
        const entitlements = await this.getUserEntitlements(user);
        const capabilities = new Set();

        if (this.db) {
            if (!entitlements.length) {
                return [];
            }

            const placeholders = entitlements.map(() => '?').join(', ');
            const rows = rowsFromRaw(await this.db.raw(
                `SELECT capability_key
                 FROM ${quotedIdentifier(this.tables.entitlementCapabilities)}
                 WHERE entitlement_key IN (${placeholders})`,
                entitlements
            ));

            rows.forEach((row) => {
                if (row.capability_key) {
                    capabilities.add(row.capability_key);
                }
            });
        } else {
            entitlements.forEach((key) => {
                (DEFAULT_ENTITLEMENTS[key] || []).forEach((capability) => capabilities.add(capability));
            });
        }

        return sorted(Array.from(capabilities));
    }

    async canQueueOfflineDirectMessage(sender, recipient) {
        const senderCapabilities = await this.getUserCapabilities(sender);
        if (senderCapabilities.includes('async_message.send_to_offline')) {
            return true;
        }

        const recipientCapabilities = await this.getUserCapabilities(recipient);
        return recipientCapabilities.includes('async_message.receive_from_anyone');
    }

    async projectUserMetadata(user) {
        const metadata = {};
        const entitlements = await this.getUserEntitlements(user);

        entitlements.forEach((key) => {
            metadata[`entitlement/${key}`] = 'true';
        });

        return metadata;
    }
}

function parseOverlay(text) {
    const users = Object.create(null);
    let section = null;
    let currentUsername = null;

    String(text || '').split(/\r?\n/).forEach((rawLine) => {
        const lineWithoutComment = rawLine.replace(/\s+#.*$/, '');
        const trimmed = lineWithoutComment.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            return;
        }

        if (/^users\s*:\s*$/.test(trimmed)) {
            section = 'users';
            currentUsername = null;
            return;
        }

        if (/^[A-Za-z0-9_.@-]+\s*:\s*$/.test(lineWithoutComment)) {
            section = null;
            currentUsername = null;
            return;
        }

        if (section !== 'users') {
            return;
        }

        const userMatch = lineWithoutComment.match(/^\s{2}([A-Za-z0-9_.@-]+)\s*:\s*$/);
        if (userMatch) {
            currentUsername = normalizeUsername(userMatch[1]);
            if (!users[currentUsername]) {
                users[currentUsername] = [];
            }
            return;
        }

        const grantMatch = lineWithoutComment.match(/^\s{4}-\s*([A-Za-z0-9_.:-]+)\s*$/);
        if (grantMatch && currentUsername) {
            users[currentUsername].push(grantMatch[1]);
        }
    });

    Object.keys(users).forEach((username) => {
        users[username] = sorted(Array.from(new Set(users[username])));
    });

    return { users };
}

function rowsFromRaw(result) {
    if (Array.isArray(result) && Array.isArray(result[0])) {
        return result[0];
    }

    if (Array.isArray(result)) {
        return result;
    }

    if (result && Array.isArray(result.rows)) {
        return result.rows;
    }

    return [];
}

function quotedIdentifier(name) {
    validateIdentifier(name);
    return `\`${name.replace(/`/g, '``')}\``;
}

function validateIdentifier(name) {
    if (!/^[A-Za-z0-9_]+$/.test(name || '')) {
        throw new Error(`Invalid SQL identifier: ${name}`);
    }
}

function normalizeUsername(username) {
    return String(username || '').trim().toLowerCase();
}

function sorted(values) {
    return values.filter(Boolean).sort();
}

module.exports = RelayosEntitlements;
module.exports.parseOverlay = parseOverlay;
