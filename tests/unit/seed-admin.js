const { parseSeedConfig, upsertSeededAdmin } = require('../../scripts/seed-admin');

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

    const userRef = state.users[0];
    const networkRef = state.networks[0];

    const second = upsertSeededAdmin(state, {
      ...cfg,
      password: 'changed',
      host: 'irc.backup.example.org',
      port: 7000,
      tls: false,
      channels: '',
    });

    expect(second.user).toBe(userRef);
    expect(second.network).toBe(networkRef);
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
  });
});
