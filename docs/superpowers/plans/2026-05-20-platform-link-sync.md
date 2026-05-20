# Platform Link Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the RelayBNC platform account-link route create a tenant-local link and immediately project the platform entitlement snapshot into tenant cache.

**Architecture:** Keep platform linking separate from tenant WordPress OAuth login. The BNC webchat extension exchanges a platform OAuth callback into a platform subject, upserts `relayos_platform_links`, fetches the platform snapshot endpoint, and writes only tenant-local `relayos_platform_entitlement_cache` rows. Runtime policy continues to read only tenant-local cache.

**Tech Stack:** Node.js KiwiBNC custom module overlay, MariaDB/Knex-style raw SQL, Python unittest contract tests, Woodpecker image publish.

---

### Task 1: Link-Time Snapshot Helpers

**Files:**
- Modify: `custom-modules/tests/test_kiwibnc_webchat_oauth_overlay_contract.py`
- Modify: `custom-modules/kiwibnc/extensions/webchat/routes_platform_link.js`

- [ ] **Step 1: Write failing contract assertions**

Require `routes_platform_link.js` to export and contain:

```text
exchangePlatformOauthCode
fetchPlatformEntitlementSnapshot
upsertPlatformAccountLink
cachePlatformEntitlementSnapshot
POST
grant_type=authorization_code
INSERT INTO `relayos_platform_links`
INSERT INTO `relayos_platform_entitlement_cache`
ON DUPLICATE KEY UPDATE
DELETE FROM `relayos_platform_entitlement_cache`
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
python3 -m unittest custom-modules/tests/test_kiwibnc_webchat_oauth_overlay_contract.py -v
```

Expected: FAIL until the helpers exist.

- [ ] **Step 3: Implement minimal helpers**

Add dependency-injectable helper functions to `routes_platform_link.js`:

```javascript
async function exchangePlatformOauthCode(config, code, httpPost) { ... }
async function fetchPlatformEntitlementSnapshot(config, platformUserId, httpGet) { ... }
async function upsertPlatformAccountLink(config, tenantUser, platformSubjectId, db) { ... }
async function cachePlatformEntitlementSnapshot(config, tenantUser, platformSubjectId, snapshot, db) { ... }
```

The cache helper deletes prior rows for that tenant/user/platform subject, then inserts active entitlements returned by the snapshot.

- [ ] **Step 4: Run the contract test**

Run:

```bash
python3 -m unittest custom-modules/tests/test_kiwibnc_webchat_oauth_overlay_contract.py -v
```

Expected: PASS.

### Task 2: Callback Route

**Files:**
- Modify: `custom-modules/tests/test_kiwibnc_webchat_oauth_overlay_contract.py`
- Modify: `custom-modules/kiwibnc/extensions/webchat/routes_platform_link.js`

- [ ] **Step 1: Write failing route contract assertions**

Require route snippets:

```text
router.get('/platform/callback'
ctx.query.code
platform_user_id
platform_subject_id
Platform account linked
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
python3 -m unittest custom-modules/tests/test_kiwibnc_webchat_oauth_overlay_contract.py -v
```

Expected: FAIL until callback route exists.

- [ ] **Step 3: Implement minimal callback**

The callback route must require a tenant user session, require `ctx.query.code`, exchange it, derive `platform_subject_id`, upsert the link, sync the snapshot, and return a small success body.

- [ ] **Step 4: Run tests**

Run:

```bash
python3 -m unittest discover -s custom-modules/tests -p 'test_kiwibnc_*.py' -v
```

Expected: PASS.

### Task 3: Commit And Push

**Files:**
- Commit all modified KiwiBNC files.

- [ ] **Step 1: Verify local contracts**

Run:

```bash
python3 -m unittest discover -s custom-modules/tests -p 'test_kiwibnc_*.py' -v
```

Expected: PASS.

- [ ] **Step 2: Commit and push**

Run:

```bash
git add custom-modules/tests/test_kiwibnc_webchat_oauth_overlay_contract.py custom-modules/kiwibnc/extensions/webchat/routes_platform_link.js docs/superpowers/plans/2026-05-20-platform-link-sync.md
git commit -m "feat: sync platform entitlements on account link"
git push
```

Expected: Woodpecker publishes a new `ghcr.io/relayos/kiwibnc:sha-...` image.
