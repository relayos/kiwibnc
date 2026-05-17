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
- Table prefix support for KiwiBNC user tables and migration metadata.
- Stale SQLite `users.db` retirement after successful SQL migrations.

Keep examples generic (`kiwibnc`, `ExampleNet`, `irc.example.test`). Do not
include WordPress, OAuth, RelayOS, or `bnc_` as product policy beyond neutral
table-prefix examples.

### Normalize Inserted IDs

Branch name:

- `upstreamable/normalize-inserted-ids`

Files:

- `src/libs/dataModels/databasesavable.js`
- `tests/unit/users.js`

Scope:

- Normalize insert IDs returned by different Knex clients, including SQLite
  scalar IDs and SQL clients that return objects with an `id` property.

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
