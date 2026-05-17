# RelayBNC Custom Modules

This directory contains RelayOS-owned KiwiBNC extensions and overlays for the
RelayBNC distribution. Keep this tree focused on modules that can be copied into
a KiwiBNC image without carrying RelayOS product policy in the KiwiBNC core fork.

## Fork Split Findings

Recent `relayos/kiwibnc` work falls into three buckets:

- Keep in the KiwiBNC fork for now: MySQL/MariaDB user database support, user
  table prefixes, DSN parsing, inserted-ID normalization, `wp_user_id` model
  support, WordPress FK migrations, stale `users.db` retirement, and default
  OAuth network/channel persistence. These depend on KiwiBNC internals or active
  migrations and should move only after clean generic hooks exist.
- Move later: OAuth routes, webchat login UX, WordPress identity binding policy,
  and RelayOS-specific registration behavior. These should become a RelayBNC
  auth module after the core exposes stable seams for route registration, client
  config injection, user mutation, and external migrations.
- Move now: MariaDB message history storage. KiwiBNC already supports
  `logging.custom`, so message persistence can live here without more divergence from upstream KiwiBNC.

The target shape is a boring RelayBNC distro: upstream KiwiBNC plus a small
RelayOS module set, packaged by deploy/image repositories. Avoid merging rough
POC branches directly; extract the behavior into focused modules with tests.

## RelayOS Webchat/OAuth Overlay

RelayOS KiwiBNC webchat and OAuth policy now lives in this custom-modules tree
instead of the core `relayos/kiwibnc` fork. The image build enables it with the
standard overlay step:

```dockerfile
COPY custom-modules/kiwibnc/ /app/src/
```

That copy places the RelayOS-owned files under `extensions/webchat/` in the
KiwiBNC image. The overlay owns the WordPress/OAuth login route, webchat client
configuration, and browser login handoff UX while leaving stock KiwiBNC source
free of RelayOS product policy.

The webchat/OAuth overlay files are:

- `extensions/webchat/index.js`
- `extensions/webchat/routes_client.js`
- `extensions/webchat/routes_oauth.js`
- `extensions/webchat/kiwibnc_plugin.html`

Do not copy unrelated upstream KiwiBNC webchat files into this repository. Keep
this tree limited to RelayOS behavior that intentionally overlays the image at
build time.

## MariaDB Message Store

The RelayBNC KiwiBNC message store module is:

- `worker/messagestores/mariadb.js`

Copy this file into the KiwiBNC image and configure KiwiBNC with:

```ini
[logging]
custom="/app/src/worker/messagestores/mariadb.js"

[message_store_mariadb]
messages_dsn="mysql://user:password@db.example:3306/wordpress"
messages_table="bnc_messages"
users_table="bnc_users"
networks_table="bnc_user_networks"
buffer_normalize="lower"
auto_migrate=true
```

The store writes `PRIVMSG` and `NOTICE` rows to `bnc_messages`, reads them back
through KiwiBNC's existing CHATHISTORY interface, and creates foreign keys to
`bnc_users` and `bnc_user_networks` when `auto_migrate` is enabled. Runtime
connection state remains KiwiBNC-local in `connections.db`.

The import helper:

- `tools/mariadb_jsonl_to_loadfile.js`

converts IRC-style JSONL exports into a tab-separated file suitable for MariaDB
`LOAD DATA LOCAL INFILE` backfills into `bnc_messages`.
