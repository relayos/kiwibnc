# RelayBNC Upstreaming Map

`master` is the integrated RelayBNC mainline. Keep it deployable and green.
When preparing upstream KiwiBNC pull requests, branch from `kiwi/master` and
cherry-pick or reapply only the files listed in the upstreamable lanes below.

## Upstreamable Lanes

### Config Environment Overrides

Branch name:

- `upstreamable/config-env-overrides`

Files:

- `src/libs/config.js`
- `tests/unit/config.js`

Scope:

- Direct scalar `BNC_*` overrides.
- Nested env overrides for existing and env-only config sections.
- Shared env value parsing for JSON-like values.

Do not include RelayBNC image, OAuth, WordPress, or custom-module packaging
content in this branch.

### SQL User Database Support

Branch name:

- `upstreamable/sql-user-database`

Files:

- `src/libs/database.js`
- `tests/unit/database.js`

Scope:

- MySQL/MariaDB user DB DSN parsing.

Keep examples generic (`kiwibnc`, `ExampleNet`, `irc.example.test`). Do not
include stale SQLite retirement, table prefixes, WordPress, OAuth, RelayOS, or
product-specific policy.

### Retire Stale SQLite Users DB

Branch name:

- `upstreamable/retire-stale-users-db`

Files:

- `src/libs/database.js`
- `tests/unit/database.js`

Scope:

- Archive a previously configured SQLite `users.db` only after effective
  MySQL/MariaDB user DB migrations succeed.
- Leave active SQLite configs and direct SQL configs without a prior SQLite path
  untouched.

This branch is intentionally separate from SQL user database support because it
is a migration safety behavior, not a SQL connection feature.

### User Table Prefixes

Branch name:

- `upstreamable/user-table-prefixes`

Files:

- `src/libs/database.js`
- `tests/unit/database.js`

Scope:

- Prefix KiwiBNC user tables through Knex identifier wrapping.
- Prefix user DB migration metadata table names for shared databases.

This branch is intentionally separate from SQL user database support because it
works for the existing SQLite user DB path and does not require SQL DSN parsing.

### Normalize Inserted IDs

Branch name:

- `upstreamable/normalize-inserted-ids`

Files:

- `src/libs/dataModels/databasesavable.js`
- `tests/unit/users.js`

Scope:

- Normalize insert IDs returned by different Knex clients, including SQLite
  scalar IDs and SQL clients that return objects with an `id` property.
- Avoid calling Knex `.returning()` for MySQL-compatible clients that do not
  support it and return insert IDs from `insert()` directly.

This branch is intentionally separate from SQL user database support because it
is useful for any non-SQLite driver and is a small compatibility fix.

### Persist Network Channels

Branch name:

- `upstreamable/persist-network-channels`

Files:

- `src/worker/users.js`
- `tests/unit/users.js`

Scope:

- Persist configured network `channels` in `Users.addNetwork()` so seeded or
  API-created networks preserve their initial channel list.

This branch is intentionally separate from SQL user database support because it
is a small data-model behavior fix with no SQL dependency.

### SQLite Retention Cleanup Timer

Branch name:

- `upstreamable/sqlite-retention-cleanup-timer`

Files:

- `src/worker/messagestores/sqlite.js`
- `tests/unit/sqlite_messagestore.js`

Scope:

- Track the SQLite message-retention cleanup interval so tests and shutdown
  paths can close it explicitly.
- Add a `close()` helper that clears the interval and closes the SQLite handle.

This branch is intentionally separate from custom message-store work because it
only fixes local SQLite resource cleanup and does not affect message-store
selection semantics.

### Custom Message Store Read Precedence

Branch name:

- `upstreamable/custom-message-store-read-precedence`

Files:

- `src/worker/messagestores/index.js`
- `tests/unit/messagestores.js`

Scope:

- When multiple readable message stores are configured, prefer the last loaded
  readable store for history reads.
- This lets `logging.custom` overlays own `CHATHISTORY` reads while preserving
  existing SQLite or flat-file write fanout.

This branch is intentionally generic: it should not mention MariaDB, RelayOS,
WordPress, or any product-specific custom module. The RelayBNC MariaDB store
depends on this seam, but the behavior is useful for any KiwiBNC custom message
store.

## RelayBNC-Only Lanes

### Distro Image And CI

Files:

- `.dockerignore`
- `.woodpecker.yml`
- `Dockerfile`
- `docker-entrypoint.sh`
- `tests/unit/custom-modules-packaging.js`
- `tests/unit/docker-entrypoint.js`

Scope:

- GHCR image publication.
- Woodpecker validation.
- `/data` container home.
- Copying the vendored custom-module overlay into `/app/src`.

This is not an upstream KiwiBNC branch. Longer term, this can move to a
dedicated RelayBNC distro/build repository if we want the KiwiBNC fork to carry
only source changes.

### RelayOS Custom Modules Snapshot

Files:

- `custom-modules/`

Scope:

- RelayOS OAuth/webchat overlay.
- WordPress identity linkage policy.
- MariaDB message-history store.
- Contract tests that ensure product policy stays out of core source.

This is not an upstream KiwiBNC branch. Sync meaningful changes back to the
source custom-modules repository before updating this snapshot.

## Compatibility-Only Lane

Files:

- `src/dbschemas/users/20260516190000_wordpress_user_fk.js`
- `src/dbschemas/users/20260516201000_bnc_child_fks.js`

Scope:

- No-op migration filenames retained because deployed RelayBNC databases may
  already have these names recorded in Knex migration metadata.

Do not delete these from RelayBNC main without a deliberate migration-table
reconciliation plan. Do not submit them upstream.

## Extraction Order

1. Keep landing cleanup commits on `master` while staging is active.
2. For each upstreamable lane, create a fresh branch from `kiwi/master`.
3. Reapply the lane files only, run the lane tests, and remove any RelayBNC-only
   references from commit messages and docs.
4. Merge the finished branch back into RelayBNC `master` only after it has also
   been represented in the integrated line.
5. Leave RelayBNC-only distro and custom-module work on `master` until a
   dedicated distro repository exists.

## Clean Main Rehearsal

Branch name:

- `relaybnc/clean-main-preview`

Purpose:

- Reconstruct the deployable RelayBNC tree from `kiwi/master` plus the
  upstreamable and RelayBNC-only lanes.
- Prove the reconstructed tree matches current `master` before any history
  rewrite is considered.

Merge order:

1. `upstreamable/config-env-overrides`
2. `upstreamable/sql-user-database`
3. `upstreamable/retire-stale-users-db`
4. `upstreamable/user-table-prefixes`
5. `upstreamable/normalize-inserted-ids`
6. `upstreamable/persist-network-channels`
7. `upstreamable/sqlite-retention-cleanup-timer`
8. `upstreamable/custom-message-store-read-precedence`
9. `relaybnc/distro-custom-modules`
10. `relaybnc/deployed-migration-stubs`
11. `relaybnc/mariadb-message-store-fixes`
12. `relaybnc/upstreaming-map-maintenance`

Known conflict resolutions:

- `src/libs/database.js` and `tests/unit/database.js` should resolve to the
  integrated tree after merging SQL DSN, stale SQLite retirement, and table
  prefix branches.
- `tests/unit/users.js` should resolve to the integrated tree after merging
  inserted-ID normalization and network-channel persistence.

Verification:

- Run the focused Jest set that covers config, database, users, message stores,
  distro packaging, and entrypoint behavior.
- Run `python3 -m unittest discover -s custom-modules/tests -p
  'test_kiwibnc_*.py' -v`.
- Confirm `git diff --quiet HEAD master` from the clean preview before treating
  it as a candidate replacement for `master`.

Rollback guardrail:

- Keep `backup/master-before-clean-rebuild` pointing at the pre-rewrite
  integrated `master` before any force update of `origin/master`.
- Prefer `git push --force-with-lease origin relaybnc/clean-main-preview:master`
  only after the branch has passed CI and human review. Do not use a plain
  force push.
