const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseSeedConfig,
  upsertSeededAdmin,
  openDb,
  upsertSeededAdminDb,
  closeDb,
  waitForProfile,
} = require('../../scripts/seed-admin');
const Database = require('../../src/libs/database');
const Crypt = require('../../src/libs/crypt');
const UserModel = require('../../src/libs/dataModels/user');
const NetworkModel = require('../../src/libs/dataModels/network');

function makeProfileDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kiwibnc-seed-admin-'));
}

function createMemoryDb() {
  const tables = {
    users: [],
    user_networks: [],
  };
  const counters = {
    users: 0,
    user_networks: 0,
  };

  function matches(row, filters) {
    return filters.every(({ column, operator, value }) => {
      if (operator === 'LIKE') {
        return String(row[column]) === String(value);
      }
      if (operator === '!=') {
        return row[column] !== value;
      }
      return row[column] === value;
    });
  }

  function makeBuilder(table) {
    const filters = [];

    return {
      where(column, operatorOrValue, maybeValue) {
        if (arguments.length === 2) {
          filters.push({ column, operator: '=', value: operatorOrValue });
        } else {
          filters.push({ column, operator: operatorOrValue, value: maybeValue });
        }
        return this;
      },
      first() {
        return Promise.resolve(tables[table].find((row) => matches(row, filters)) || null);
      },
      then(onFulfilled, onRejected) {
        return Promise.resolve(tables[table].filter((row) => matches(row, filters))).then(onFulfilled, onRejected);
      },
      insert(data) {
        const row = { ...data, id: ++counters[table] };
        tables[table].push(row);
        return {
          returning() {
            return Promise.resolve([row.id]);
          },
        };
      },
      update(data) {
        let count = 0;
        tables[table].forEach((row) => {
          if (matches(row, filters)) {
            Object.assign(row, data);
            count += 1;
          }
        });
        return Promise.resolve(count);
      },
      delete() {
        const nextRows = [];
        let count = 0;
        tables[table].forEach((row) => {
          if (matches(row, filters)) {
            count += 1;
          } else {
            nextRows.push(row);
          }
        });
        tables[table] = nextRows;
        return Promise.resolve(count);
      },
    };
  }

  const db = {
    dbUsers(table) {
      return makeBuilder(table);
    },
    factories: Object.create(null),
    tables,
  };

  db.factories.User = UserModel.factory(db);
  db.factories.Network = NetworkModel.factory(db, new Crypt('0123456789abcdef0123456789abcdef'));

  return db;
}

describe('scripts/seed-admin.js', () => {
  test('parseSeedConfig normalizes the rendered admin JSON payload', () => {
    const cfg = parseSeedConfig(JSON.stringify({
      username: 'admin',
      password: 'secret',
      network_name: 'KiwiNet',
      irc_host: 'irc.example.org',
      irc_port: '6697',
      irc_tls: 'true',
      irc_nick: 'kiwi',
      irc_username: 'kiwi-user',
      irc_realname: 'Kiwi Admin',
    }));

    expect(cfg).toEqual({
      username: 'admin',
      password: 'secret',
      networkName: 'KiwiNet',
      host: 'irc.example.org',
      port: 6697,
      tls: true,
      nick: 'kiwi',
      usernameOnIrc: 'kiwi-user',
      realname: 'Kiwi Admin',
      channels: '',
    });
  });

  test('upsertSeededAdmin creates one user and one network, then updates in place', () => {
    const state = {
      users: [],
      networks: [],
    };
    const cfg = {
      username: 'admin',
      password: 'secret',
      networkName: 'KiwiNet',
      host: 'irc.example.org',
      port: 6697,
      tls: true,
      nick: 'kiwi',
      usernameOnIrc: 'kiwi-user',
      realname: 'Kiwi Admin',
      channels: '#kiwi',
    };

    const first = upsertSeededAdmin(state, cfg);

    expect(first.user).toEqual({
      id: 1,
      username: 'admin',
      password: 'secret',
      admin: true,
    });
    expect(first.network).toEqual({
      id: 1,
      user_id: 1,
      name: 'KiwiNet',
      host: 'irc.example.org',
      port: 6697,
      tls: true,
      nick: 'kiwi',
      username: 'kiwi-user',
      realname: 'Kiwi Admin',
      channels: '#kiwi',
    });
    expect(state.users).toHaveLength(1);
    expect(state.networks).toHaveLength(1);

    const second = upsertSeededAdmin(state, {
      ...cfg,
      password: 'changed',
      host: 'irc.backup.example.org',
      port: 7000,
      tls: false,
      channels: '',
    });

    expect(state.users).toHaveLength(1);
    expect(state.networks).toHaveLength(1);
    expect(state.users[0]).toEqual({
      id: 1,
      username: 'admin',
      password: 'changed',
      admin: true,
    });
    expect(state.networks[0]).toEqual({
      id: 1,
      user_id: 1,
      name: 'KiwiNet',
      host: 'irc.backup.example.org',
      port: 7000,
      tls: false,
      nick: 'kiwi',
      username: 'kiwi-user',
      realname: 'Kiwi Admin',
      channels: '',
    });
    expect(second.user.id).toBe(1);
    expect(second.network.id).toBe(1);
  });

  test('waitForProfile fails fast when profile files do not appear', async () => {
    const profileDir = makeProfileDir();
    try {
      await expect(
        waitForProfile(profileDir, { timeoutMs: 50, pollMs: 10 })
      ).rejects.toThrow(/Timed out waiting for KiwiBNC profile/);
    } finally {
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  });

  test('openDb initializes the factories needed by the DB-backed helper', async () => {
    const profileDir = makeProfileDir();
    const initSpy = jest.spyOn(Database.prototype, 'init').mockResolvedValue();
    let db;

    try {
      fs.writeFileSync(
        path.join(profileDir, 'config.ini'),
        [
          '[database]',
          'users = "users.db"',
          'crypt_key = "0123456789abcdef0123456789abcdef"',
          '',
        ].join('\n')
      );
      fs.writeFileSync(path.join(profileDir, 'users.db'), '');

      db = await openDb(profileDir);

      expect(initSpy).toHaveBeenCalledTimes(1);
      expect(db.factories.User).toEqual(expect.any(Function));
      expect(db.factories.Network).toEqual(expect.any(Function));
    } finally {
      if (db) {
        await db.dbUsers.destroy();
        await db.dbConnections.destroy();
      }
      initSpy.mockRestore();
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  });

  test('openDb rejects an invalid crypt key before initialization', async () => {
    const profileDir = makeProfileDir();
    const initSpy = jest.spyOn(Database.prototype, 'init');

    try {
      fs.writeFileSync(
        path.join(profileDir, 'config.ini'),
        [
          '[database]',
          'users = "users.db"',
          'crypt_key = "too-short"',
          '',
        ].join('\n')
      );
      fs.writeFileSync(path.join(profileDir, 'users.db'), '');

      await expect(openDb(profileDir)).rejects.toThrow(
        'database.crypt_key must be 32 characters long'
      );
      expect(initSpy).not.toHaveBeenCalled();
    } finally {
      initSpy.mockRestore();
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  });

  test('openDb closes a partially constructed database when init rejects', async () => {
    jest.resetModules();

    const destroyUsers = jest.fn().mockResolvedValue();
    const destroyConnections = jest.fn().mockResolvedValue();
    const initError = new Error('init failed');
    const dbInstance = {
      dbUsers: { destroy: destroyUsers },
      dbConnections: { destroy: destroyConnections },
      init: jest.fn().mockRejectedValue(initError),
      factories: Object.create(null),
    };
    const DatabaseMock = jest.fn(() => dbInstance);

    jest.doMock('../../src/libs/database', () => DatabaseMock);

    try {
      const { openDb: mockedOpenDb } = require('../../scripts/seed-admin');
      const profileDir = makeProfileDir();

      try {
        fs.writeFileSync(
          path.join(profileDir, 'config.ini'),
          [
            '[database]',
            'users = "users.db"',
            'crypt_key = "0123456789abcdef0123456789abcdef"',
            '',
          ].join('\n')
        );
        fs.writeFileSync(path.join(profileDir, 'users.db'), '');

        await expect(mockedOpenDb(profileDir)).rejects.toThrow('init failed');
        expect(DatabaseMock).toHaveBeenCalledTimes(1);
        expect(destroyUsers).toHaveBeenCalledTimes(1);
        expect(destroyConnections).toHaveBeenCalledTimes(1);
      } finally {
        fs.rmSync(profileDir, { recursive: true, force: true });
      }
    } finally {
      jest.dontMock('../../src/libs/database');
      jest.resetModules();
    }
  });

  test('closeDb destroys both database handles', async () => {
    const dbUsersDestroy = jest.fn().mockResolvedValue();
    const dbConnectionsDestroy = jest.fn().mockResolvedValue();

    await closeDb({
      dbUsers: { destroy: dbUsersDestroy },
      dbConnections: { destroy: dbConnectionsDestroy },
    });

    expect(dbUsersDestroy).toHaveBeenCalledTimes(1);
    expect(dbConnectionsDestroy).toHaveBeenCalledTimes(1);
  });

  test('upsertSeededAdminDb persists and updates through the real model factories', async () => {
    const db = createMemoryDb();

    const first = await upsertSeededAdminDb(db, {
      username: 'admin',
      password: 'secret',
      networkName: 'KiwiNet',
      host: 'irc.example.org',
      port: 6697,
      tls: true,
      nick: 'kiwi',
      usernameOnIrc: 'kiwi-user',
      realname: 'Kiwi Admin',
      channels: '#kiwi',
    });

    expect(first.user.id).toBeGreaterThan(0);
    expect(first.network.id).toBeGreaterThan(0);
    expect(first.user.created_at).toEqual(expect.any(Number));
    expect(db.tables.users).toHaveLength(1);
    expect(db.tables.user_networks).toHaveLength(1);
    expect(db.tables.users[0]).toMatchObject({
      username: 'admin',
      admin: true,
    });
    expect(db.tables.users[0].created_at).toEqual(expect.any(Number));
    expect(db.tables.user_networks[0]).toMatchObject({
      name: 'KiwiNet',
      host: 'irc.example.org',
      port: 6697,
      tls: true,
      nick: 'kiwi',
      username: 'kiwi-user',
      realname: 'Kiwi Admin',
      channels: '#kiwi',
    });

    const second = await upsertSeededAdminDb(db, {
      username: 'admin',
      password: 'changed',
      networkName: 'KiwiNet',
      host: 'irc.backup.example.org',
      port: 7000,
      tls: false,
      nick: 'kiwi',
      usernameOnIrc: 'kiwi-user',
      realname: 'Kiwi Admin',
      channels: '',
    });

    expect(second.user.id).toBe(first.user.id);
    expect(second.network.id).toBe(first.network.id);
    expect(db.tables.users).toHaveLength(1);
    expect(db.tables.user_networks).toHaveLength(1);
    expect(db.tables.users[0]).toMatchObject({
      username: 'admin',
      admin: true,
    });
    expect(db.tables.user_networks[0]).toMatchObject({
      name: 'KiwiNet',
      host: 'irc.backup.example.org',
      port: 7000,
      tls: false,
      nick: 'kiwi',
      username: 'kiwi-user',
      realname: 'Kiwi Admin',
      channels: '',
    });
  });
});
