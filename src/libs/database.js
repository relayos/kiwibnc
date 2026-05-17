const path = require('path');
const fs = require('fs');
const knex = require('knex');

const USER_DB_TABLES = new Set([
    'connections',
    'users',
    'user_networks',
    'user_tokens',
]);

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

function isMysqlConnectionString(connectionString) {
    return !!connectionString &&
        (
            connectionString.indexOf('mysql://') > -1 ||
            connectionString.indexOf('mariadb://') > -1
        );
}

function timestampForFilename() {
    return (new Date()).toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}Z$/, 'Z');
}

function nextRetiredPath(filePath) {
    const basePath = `${filePath}.retired-${timestampForFilename()}`;
    let retiredPath = `${basePath}.bak`;
    let counter = 1;

    while (fs.existsSync(retiredPath)) {
        retiredPath = `${basePath}-${counter}.bak`;
        counter++;
    }

    return retiredPath;
}

function logRetiredUsersDb(sourcePath, retiredPath) {
    const msg = `Retired stale SQLite users database ${sourcePath} to ${retiredPath} because database.users is configured for MySQL/MariaDB`;
    if (global.l && global.l.warn) {
        global.l.warn(msg);
    } else {
        console.warn(msg);
    }
}

function configuredSqliteUsersPath(config, configuredUsersConStr, hasConfiguredDatabase) {
    if (!hasConfiguredDatabase) {
        return null;
    }

    const usersConStr = configuredUsersConStr || 'users.db';
    if (usersConStr.indexOf('postgres://') > -1 ||
        isMysqlConnectionString(usersConStr)) {
        return null;
    }

    return config.relativePath(usersConStr);
}

function archiveStaleUsersDb(usersDbPath) {
    if (!usersDbPath) {
        return;
    }

    if (!fs.existsSync(usersDbPath)) {
        return;
    }

    if (!fs.statSync(usersDbPath).isFile()) {
        return;
    }

    const retiredPath = nextRetiredPath(usersDbPath);
    fs.renameSync(usersDbPath, retiredPath);
    logRetiredUsersDb(usersDbPath, retiredPath);
}

module.exports = class Database {
    constructor(config) {
        let hasConfiguredDatabase = !!(config.c && config.c.database);
        let configuredUsersConStr = config.c && config.c.database ?
            config.c.database.users :
            undefined;
        let dbConf = config.get('database', {});
        let userTablePrefix = dbConf.table_prefix || '';
        this.staleUsersDbPath = null;
        this.userMigrationTableName = `${userTablePrefix}knex_migrations`;
        let wrapUserIdentifier = (value, origImpl) => {
            let prefixedValue = USER_DB_TABLES.has(value) ?
                `${userTablePrefix}${value}` :
                value;
            return origImpl(prefixedValue);
        };

		this.dbConnections = knex({
			client: 'better-sqlite3',
			connection: {
                // dbConf.path is legacy
				filename: config.relativePath(dbConf.state || dbConf.path || 'connections.db'),
			},
            useNullAsDefault: true,
            pool: { propagateCreateError: false },
        });

        let usersConStr = dbConf.users || 'users.db';
        let usersDbCon = {
			client: 'better-sqlite3',
            connection: null,
            acquireConnectionTimeout: 10000,
        };
        if (usersConStr.indexOf('postgres://') > -1) {
            // postgres://someuser:somepassword@somehost:381/somedatabase
            usersDbCon.client = 'pg';
            usersDbCon.connection = usersConStr;
            usersDbCon.wrapIdentifier = wrapUserIdentifier;
            let searchPathM = usersConStr.match(/searchPath=([^&]+)/);
            if (searchPathM) {
                usersDbCon.searchPath = searchPathM[1].split(',');
            }
        } else if (isMysqlConnectionString(usersConStr)) {
            this.staleUsersDbPath = configuredSqliteUsersPath(config, configuredUsersConStr, hasConfiguredDatabase);
            // mysql://user:password@127.0.0.1:3306/database
            usersDbCon = {
                client: 'mysql',
                connection: parseMysqlConnectionString(usersConStr),
                wrapIdentifier: wrapUserIdentifier,
                acquireConnectionTimeout: 10000,
            };
        } else {
            // No scheme:// part in the connection string, assume it's an sqlite filename
            usersDbCon.client = 'better-sqlite3';
            usersDbCon.useNullAsDefault = true;
            usersDbCon.connection = { filename: config.relativePath(usersConStr) };
            usersDbCon.pool = { propagateCreateError: false };
            usersDbCon.wrapIdentifier = wrapUserIdentifier;
        }

        this.dbUsers = knex(usersDbCon);

        // Some older extensions make use of .db for user data access
        this.db = this.dbUsers;

        this.factories = Object.create(null);

        // The users db abstractions will set itself here
        this.users = null;
    }

    get(sql, params) {
        return this.dbUsers.raw(sql, params).then(rows => rows[0]);
    }

    all(sql, params) {
        return this.dbUsers.raw(sql, params);
    }

    run(sql, params) {
        return this.dbUsers.raw(sql, params);
    }

    migrateConnections() {
        return this.dbConnections.migrate.latest({
            directory: path.join(__dirname, '..', 'dbschemas', 'connections'),
        });
    }

    migrateUsers() {
        return this.dbUsers.migrate.latest({
            directory: path.join(__dirname, '..', 'dbschemas', 'users'),
            tableName: this.userMigrationTableName,
        });
    }

    async init() {
        await this.migrateConnections();
        await this.migrateUsers();
        archiveStaleUsersDb(this.staleUsersDbPath);
    }
}
