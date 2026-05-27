const createLogger = require('../../libs/logger');

const l = createLogger('webchat-bnc-provisioning');
const WORDPRESS_USERS_REFERENCE_SQL = 'REFERENCES `wp_users` (`ID`)';
const DEFAULT_TENANT_ID = process.env.RELAYOS_TENANT_ID || 'relayos-tenant';

function quotedIdentifier(knex, name) {
    return knex.client.wrapIdentifier(name, (value) => `\`${value.replace(/`/g, '``')}\``);
}

function unquotedIdentifier(knex, name) {
    return quotedIdentifier(knex, name).replace(/^`|`$/g, '').replace(/``/g, '`');
}

function quoteConstraint(name) {
    return `\`${name.replace(/`/g, '``')}\``;
}

function boolToSql(value) {
    return value ? 1 : 0;
}

function networkConfig(defaultNetwork = {}) {
    return {
        name: defaultNetwork.name || 'RelayOS',
        host: defaultNetwork.host || 'inspircd',
        port: Number(defaultNetwork.port || 6667),
        tls: boolToSql(defaultNetwork.tls),
        tlsverify: boolToSql(defaultNetwork.tlsverify !== false),
        channels: defaultNetwork.channels || '',
    };
}

function quotedReferenceIdentifier(knex, name) {
    return name === 'wp_users' ? '`wp_users`' : quotedIdentifier(knex, name);
}

function unquotedReferenceIdentifier(knex, name) {
    return name === 'wp_users' ? 'wp_users' : unquotedIdentifier(knex, name);
}

function rowsFromRaw(result) {
    return Array.isArray(result) ? result[0] : result.rows;
}

async function ensureUniqueIndex(knex, tableName, columnNames, indexName) {
    const rows = rowsFromRaw(await knex.raw(
        `SELECT INDEX_NAME
           FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = ?
            AND INDEX_NAME = ?`,
        [unquotedIdentifier(knex, tableName), indexName]
    ));
    if (rows.length) {
        return;
    }

    const quotedColumns = columnNames.map((columnName) => quotedIdentifier(knex, columnName)).join(', ');
    await knex.raw(
        `ALTER TABLE ${quotedIdentifier(knex, tableName)}
          ADD UNIQUE INDEX ${quoteConstraint(indexName)} (${quotedColumns})`
    );
}

async function ensureForeignKey(knex, tableName, columnName, referencedTableName, referencedColumnName, constraintName) {
    const rows = rowsFromRaw(await knex.raw(
        `SELECT CONSTRAINT_NAME
           FROM information_schema.KEY_COLUMN_USAGE
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = ?
            AND COLUMN_NAME = ?
            AND REFERENCED_TABLE_NAME = ?
            AND REFERENCED_COLUMN_NAME = ?`,
        [
            unquotedIdentifier(knex, tableName),
            columnName,
            unquotedReferenceIdentifier(knex, referencedTableName),
            referencedColumnName,
        ]
    ));
    if (rows.length) {
        return;
    }

    const referenceSql = referencedTableName === 'wp_users'
        ? WORDPRESS_USERS_REFERENCE_SQL
        : `REFERENCES ${quotedReferenceIdentifier(knex, referencedTableName)} (${quotedIdentifier(knex, referencedColumnName)})`;

    await knex.raw(
        `ALTER TABLE ${quotedIdentifier(knex, tableName)}
          ADD CONSTRAINT ${quoteConstraint(constraintName)}
          FOREIGN KEY (${quotedIdentifier(knex, columnName)})
          ${referenceSql}
          ON DELETE CASCADE
          ON UPDATE CASCADE`
    );
}

async function dropTrigger(knex, triggerName) {
    await knex.raw(`DROP TRIGGER IF EXISTS ${quotedIdentifier(knex, triggerName)}`);
}

async function installTriggers(knex, usersTable, networksTable, defaultNetwork) {
    const network = networkConfig(defaultNetwork);
    await dropTrigger(knex, 'wordpress_users_bnc_after_insert');
    await dropTrigger(knex, 'wordpress_users_bnc_after_update');
    await dropTrigger(knex, 'wordpress_users_bnc_after_delete');

    await knex.raw(`
CREATE TRIGGER wordpress_users_bnc_after_insert
AFTER INSERT ON \`wp_users\`
FOR EACH ROW
BEGIN
  INSERT INTO ${usersTable} (username, password, admin, created_at, wp_user_id)
  VALUES (NEW.user_login, bcrypt_hash(CONCAT('oauth-unusable-', UUID()), 10), 0, COALESCE(UNIX_TIMESTAMP(NEW.user_registered), UNIX_TIMESTAMP()), NEW.ID)
  ON DUPLICATE KEY UPDATE username = VALUES(username), wp_user_id = VALUES(wp_user_id);

  INSERT INTO ${networksTable} (user_id, name, host, port, tls, tlsverify, nick, username, realname, password, sasl_account, sasl_pass, channels)
  SELECT id, ?, ?, ?, ?, ?, username, username, username, '', username, 'RELAYOS_BNC_SASL_UNPROVISIONED', ?
    FROM ${usersTable}
   WHERE wp_user_id = NEW.ID
  ON DUPLICATE KEY UPDATE host = VALUES(host), port = VALUES(port), tls = VALUES(tls), tlsverify = VALUES(tlsverify), nick = VALUES(nick), username = VALUES(username), realname = VALUES(realname), sasl_account = VALUES(sasl_account);
END`, [network.name, network.host, network.port, network.tls, network.tlsverify, network.channels]);

    await knex.raw(`
CREATE TRIGGER wordpress_users_bnc_after_update
AFTER UPDATE ON \`wp_users\`
FOR EACH ROW
BEGIN
  UPDATE ${usersTable}
     SET username = NEW.user_login
   WHERE wp_user_id = NEW.ID;

  INSERT INTO ${networksTable} (user_id, name, host, port, tls, tlsverify, nick, username, realname, password, sasl_account, sasl_pass, channels)
  SELECT id, ?, ?, ?, ?, ?, username, username, username, '', username, 'RELAYOS_BNC_SASL_UNPROVISIONED', ?
    FROM ${usersTable}
   WHERE wp_user_id = NEW.ID
  ON DUPLICATE KEY UPDATE host = VALUES(host), port = VALUES(port), tls = VALUES(tls), tlsverify = VALUES(tlsverify), nick = VALUES(nick), username = VALUES(username), realname = VALUES(realname), sasl_account = VALUES(sasl_account);
END`, [network.name, network.host, network.port, network.tls, network.tlsverify, network.channels]);

    await knex.raw(`
CREATE TRIGGER wordpress_users_bnc_after_delete
AFTER DELETE ON \`wp_users\`
FOR EACH ROW
BEGIN
  SET @relay_bnc_deleted_wp_user_id = OLD.ID;
END`);
}

async function backfillWordPressUsers(knex, defaultNetwork) {
    const usersTable = quotedIdentifier(knex, 'users');
    const networksTable = quotedIdentifier(knex, 'user_networks');
    const network = networkConfig(defaultNetwork);

    await knex.raw(
        `UPDATE ${usersTable} bnc
            JOIN \`wp_users\` wp ON LOWER(wp.user_login) = LOWER(bnc.username)
           SET bnc.wp_user_id = wp.ID
         WHERE bnc.wp_user_id IS NULL`
    );

    await knex.raw(
        `INSERT INTO ${usersTable} (username, password, admin, created_at, wp_user_id)
         SELECT wp.user_login, bcrypt_hash(CONCAT('oauth-unusable-', UUID()), 10), 0,
                COALESCE(UNIX_TIMESTAMP(wp.user_registered), UNIX_TIMESTAMP()), wp.ID
           FROM \`wp_users\` wp
           LEFT JOIN ${usersTable} bnc ON bnc.wp_user_id = wp.ID
          WHERE bnc.id IS NULL
         ON DUPLICATE KEY UPDATE wp_user_id = VALUES(wp_user_id)`
    );

    await knex.raw(
        `INSERT INTO ${networksTable} (user_id, name, host, port, tls, tlsverify, nick, username, realname, password, sasl_account, sasl_pass, channels)
         SELECT bnc.id, ?, ?, ?, ?, ?, bnc.username, bnc.username, bnc.username, '', bnc.username, 'RELAYOS_BNC_SASL_UNPROVISIONED', ?
           FROM ${usersTable} bnc
           JOIN \`wp_users\` wp ON wp.ID = bnc.wp_user_id
           LEFT JOIN ${networksTable} net ON net.user_id = bnc.id AND net.name = ?
          WHERE net.id IS NULL
         ON DUPLICATE KEY UPDATE host = VALUES(host), port = VALUES(port), tls = VALUES(tls), tlsverify = VALUES(tlsverify)`,
        [network.name, network.host, network.port, network.tls, network.tlsverify, network.channels, network.name]
    );
}

async function ensureRelayBncSaslCredentialTable(knex) {
    await knex.raw(`
CREATE TABLE IF NOT EXISTS ${quotedIdentifier(knex, 'relayos_bnc_sasl_credentials')} (
  wp_user_id BIGINT UNSIGNED NOT NULL,
  credential_hash VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  source VARCHAR(64) NOT NULL DEFAULT 'kiwibnc-oauth',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (wp_user_id),
  KEY idx_relayos_bnc_sasl_credentials_status (status, source),
  CONSTRAINT ${quoteConstraint('bnc_sasl_credentials_wp_user_id_fk')}
    FOREIGN KEY (wp_user_id) REFERENCES \`wp_users\` (\`ID\`)
    ON DELETE CASCADE
    ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci`);
}

async function ensureBncWordPressProvisioning(app, defaultNetwork) {
    // BNC provisioning is intentionally scoped to tenant WordPress users.
    // Platform account links project entitlements later; they must not create BNC users.
    const tenantId = process.env.RELAYOS_TENANT_ID || DEFAULT_TENANT_ID;
    const knex = app.db && app.db.dbUsers;
    const clientName = knex && knex.client && knex.client.config && knex.client.config.client;
    if (!knex || !knex.schema || !['mysql', 'mysql2'].includes(clientName)) {
        return;
    }

    const hasColumn = await knex.schema.hasColumn('users', 'wp_user_id');
    if (!hasColumn) {
        await knex.schema.table('users', function (table) {
            table.bigInteger('wp_user_id').unsigned().nullable().index();
        });
    }

    await knex.raw(`ALTER TABLE ${quotedIdentifier(knex, 'user_networks')} MODIFY COLUMN user_id INT(10) UNSIGNED NOT NULL`);
    await knex.raw(`ALTER TABLE ${quotedIdentifier(knex, 'user_tokens')} MODIFY COLUMN user_id INT(10) UNSIGNED NOT NULL`);

    await ensureUniqueIndex(knex, 'users', ['wp_user_id'], 'bnc_users_wp_user_id_unique');
    await ensureUniqueIndex(knex, 'user_networks', ['user_id', 'name'], 'bnc_user_networks_user_id_network_name_unique');
    await ensureForeignKey(knex, 'users', 'wp_user_id', 'wp_users', 'ID', 'bnc_users_wp_user_id_fk');
    await ensureForeignKey(knex, 'user_networks', 'user_id', 'users', 'id', 'bnc_user_networks_user_id_fk');
    await ensureForeignKey(knex, 'user_tokens', 'user_id', 'users', 'id', 'bnc_user_tokens_user_id_fk');
    await ensureRelayBncSaslCredentialTable(knex);
    await backfillWordPressUsers(knex, defaultNetwork);
    await installTriggers(knex, quotedIdentifier(knex, 'users'), quotedIdentifier(knex, 'user_networks'), defaultNetwork);

    l.info('BNC tenant WordPress provisioning ensured', { tenantId });
}

module.exports = {
    ensureBncWordPressProvisioning,
    ensureRelayBncSaslCredentialTable,
};
