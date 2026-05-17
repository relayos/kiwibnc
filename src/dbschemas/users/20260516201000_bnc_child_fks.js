exports.up = async function(knex) {
    if (knex.client.config.client !== 'mysql') {
        return;
    }

    await addUserChildForeignKey(knex, 'user_networks');
    await addUserChildForeignKey(knex, 'user_tokens');
};

exports.down = function(knex) {
    // Never go backwards in the db
};

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

function quotedIdentifier(knex, name) {
    return knex.client.wrapIdentifier(name, (value) => `\`${value.replace(/`/g, '``')}\``);
}

function unquotedIdentifier(knex, name) {
    return quotedIdentifier(knex, name).replace(/^`|`$/g, '').replace(/``/g, '`');
}

function quoteConstraint(name) {
    return `\`${name.replace(/`/g, '``')}\``;
}
