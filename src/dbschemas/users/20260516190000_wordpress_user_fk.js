exports.up = async function(knex) {
    const hasColumn = await knex.schema.hasColumn('users', 'wp_user_id');
    if (!hasColumn) {
        await knex.schema.table('users', function (table) {
            table.integer('wp_user_id').unsigned().nullable().index();
        });
    }

    if (knex.client.config.client !== 'mysql') {
        return;
    }

    const usersTable = knex.client.wrapIdentifier('users', (value) => `\`${value}\``);
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
        [usersTable.replace(/`/g, '')]
    );
    const rows = Array.isArray(constraints) ? constraints[0] : constraints.rows;
    if (rows && rows.length) {
        return;
    }

    await knex.schema.table('users', function (table) {
        table.foreign('wp_user_id')
            .references('ID')
            .inTable('wp_users')
            .onDelete('CASCADE')
            .onUpdate('CASCADE');
    });
};

exports.down = function(knex) {
    // Never go backwards in the db
};
