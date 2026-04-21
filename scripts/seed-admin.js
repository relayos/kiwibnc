#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');

const Helpers = require('../src/libs/helpers');
const Config = require('../src/libs/config');
const Database = require('../src/libs/database');
const Crypt = require('../src/libs/crypt');
const Users = require('../src/worker/users');
const NetworkModel = require('../src/libs/dataModels/network');
const UserModel = require('../src/libs/dataModels/user');

function asBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
  }

  return !!value;
}

function parseSeedConfig(raw) {
  const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;

  return {
    username: payload.username,
    password: payload.password,
    networkName: payload.network_name,
    host: payload.irc_host,
    port: Number(payload.irc_port),
    tls: asBoolean(payload.irc_tls),
    nick: payload.irc_nick,
    usernameOnIrc: payload.irc_username,
    realname: payload.irc_realname,
    channels: payload.irc_channels ?? '',
  };
}

function nextId(items) {
  return items.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;
}

function upsertSeededAdmin(state, cfg) {
  if (!state.users) {
    state.users = [];
  }
  if (!state.networks) {
    state.networks = [];
  }

  let user = state.users.find((entry) => entry.username === cfg.username);
  if (!user) {
    user = {
      id: nextId(state.users),
      username: cfg.username,
      password: cfg.password,
      admin: true,
    };
    state.users.push(user);
  } else {
    user.password = cfg.password;
    user.admin = true;
  }

  let network = state.networks.find((entry) => entry.user_id === user.id && entry.name === cfg.networkName);
  if (!network) {
    network = {
      id: nextId(state.networks),
      user_id: user.id,
      name: cfg.networkName,
      host: cfg.host,
      port: cfg.port,
      tls: cfg.tls,
      nick: cfg.nick,
      username: cfg.usernameOnIrc,
      realname: cfg.realname,
      channels: cfg.channels ?? '',
    };
    state.networks.push(network);
  } else {
    network.host = cfg.host;
    network.port = cfg.port;
    network.tls = cfg.tls;
    network.nick = cfg.nick;
    network.username = cfg.usernameOnIrc;
    network.realname = cfg.realname;
    network.channels = cfg.channels ?? '';
  }

  return { user, network };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForProfile(profileDir, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30000;
  const pollMs = options.pollMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  const files = ['config.ini', 'users.db'].map((file) => path.join(profileDir, file));

  for (;;) {
    try {
      await Promise.all(files.map((file) => fs.access(file)));
      return profileDir;
    } catch (err) {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for KiwiBNC profile in ${profileDir}`);
      }
      await sleep(pollMs);
    }
  }
}

async function openDb(profileDir) {
  const configPath = path.join(profileDir, 'config.ini');
  const config = new Config(configPath);
  config.load();

  const cryptKey = config.get('database.crypt_key', '');
  if (cryptKey.length !== 32) {
    throw new Error('database.crypt_key must be 32 characters long');
  }

  const db = new Database(config);
  try {
    await db.init();
  } catch (err) {
    try {
      await closeDb(db);
    } catch (closeErr) {
      console.error('Failed to close KiwiBNC DB after init failure:', closeErr && closeErr.stack ? closeErr.stack : closeErr);
    }
    throw err;
  }
  db.crypt = new Crypt(cryptKey);
  db.users = new Users(db);
  db.factories.Network = NetworkModel.factory(db, db.crypt);
  db.factories.User = UserModel.factory(db);
  return db;
}

async function upsertSeededAdminDb(db, cfg) {
  let user = await db.factories.User.query()
    .where('username', 'LIKE', cfg.username)
    .first();
  if (user) {
    user = db.factories.User.fromDbResult(user);
  }

  if (!user) {
    user = db.factories.User();
    user.username = cfg.username;
    user.created_at = Helpers.now();
  }

  user.password = cfg.password;
  user.admin = true;
  await user.save();

  let network = await db.factories.Network.query()
    .where('user_id', user.id)
    .where('name', 'LIKE', cfg.networkName)
    .first();
  if (network) {
    network = db.factories.Network.fromDbResult(network);
  }

  if (!network) {
    network = db.factories.Network();
    network.user_id = user.id;
    network.name = cfg.networkName;
  }

  network.host = cfg.host;
  network.port = cfg.port;
  network.tls = cfg.tls;
  network.nick = cfg.nick;
  network.username = cfg.usernameOnIrc;
  network.realname = cfg.realname;
  network.channels = cfg.channels ?? '';
  await network.save();

  return { user, network };
}

async function closeDb(db) {
  if (!db) {
    return;
  }

  const closers = [];
  if (db.dbUsers && typeof db.dbUsers.destroy === 'function') {
    closers.push(db.dbUsers.destroy());
  }
  if (db.dbConnections && typeof db.dbConnections.destroy === 'function') {
    closers.push(db.dbConnections.destroy());
  }

  await Promise.all(closers);
}

async function main() {
  const raw = process.env.RELAYOS_KIWIBNC_ADMIN_JSON;
  if (!raw) {
    throw new Error('RELAYOS_KIWIBNC_ADMIN_JSON is required');
  }

  const profileDir = path.join(process.env.HOME || '/data', '.kiwibnc');
  const cfg = parseSeedConfig(raw);
  let db = null;
  let primaryError = null;
  await waitForProfile(profileDir);
  try {
    db = await openDb(profileDir);
    await upsertSeededAdminDb(db, cfg);
    console.log(`Seeded KiwiBNC admin user ${cfg.username} in ${profileDir}`);
  } catch (err) {
    primaryError = err;
  } finally {
    try {
      await closeDb(db);
    } catch (cleanupErr) {
      console.error('Failed to close KiwiBNC DB after seeding:', cleanupErr && cleanupErr.stack ? cleanupErr.stack : cleanupErr);
      if (!primaryError) {
        primaryError = cleanupErr;
      }
    }
  }

  if (primaryError) {
    throw primaryError;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = {
  parseSeedConfig,
  upsertSeededAdmin,
  waitForProfile,
  openDb,
  upsertSeededAdminDb,
  closeDb,
  main,
};
