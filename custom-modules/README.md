# RelayBNC Custom Modules Snapshot

This tree is a CI-safe snapshot of the KiwiBNC-specific RelayOS custom modules.
The source of truth remains `relayos/custom-modules`, but this branch vendors
the files needed by the KiwiBNC image so Woodpecker does not need private
cross-repo credentials during clone.

Current layout:

- `kiwibnc/`
- `tests/test_kiwibnc_*.py`

Rules:

- Keep this snapshot limited to files needed by the KiwiBNC image.
- Sync changes back to `relayos/custom-modules` before updating this snapshot.
- Do not put deploy wiring or rendered config in this tree.
