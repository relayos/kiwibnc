# RelayBNC Custom Modules Snapshot

This tree is a CI-safe snapshot of the KiwiBNC-specific RelayOS custom modules.
The source of truth remains `relayos/custom-modules`, but this branch vendors
the files needed by the KiwiBNC image so Woodpecker does not need private
cross-repo credentials during clone.

## RelayBNC Image Notes

The RelayOS image is published as `ghcr.io/relayos/kiwibnc` from pushes to
`master`. The container expects persistent state in `/data`, sets `HOME=/data`
and `KIWIBNC_DATA_DIR=/data`, and overlays `custom-modules/kiwibnc/` into
`/app/src` during the image build.

RelayBNC should stay as close to upstream KiwiBNC as practical. RelayOS-owned
behavior should move into `custom-modules/kiwibnc` when KiwiBNC exposes a clean
extension seam. Keep in core only the generic support that cannot yet live in an
overlay, such as MySQL/MariaDB user DB support, table prefixes, DSN parsing,
inserted-ID normalization, and stale `users.db` retirement.

When the seams are proven, the intended cleanup path is to rebase the fork onto
upstream KiwiBNC and cherry-pick only the small generic core support commits.

Current layout:

- `kiwibnc/`
- `tests/test_kiwibnc_*.py`

Rules:

- Keep this snapshot limited to files needed by the KiwiBNC image.
- Sync changes back to `relayos/custom-modules` before updating this snapshot.
- Do not put deploy wiring or rendered config in this tree.
