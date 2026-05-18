import re
import json
import subprocess
import unittest
from html.parser import HTMLParser
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = REPO_ROOT / "kiwibnc/libs/relayos_entitlements.js"
BADGES_HELPER_PATH = REPO_ROOT / "kiwibnc/extensions/webchat/relayos_badges.js"
ROUTES_CLIENT_PATH = REPO_ROOT / "kiwibnc/extensions/webchat/routes_client.js"
KIWIBNC_PLUGIN_PATH = REPO_ROOT / "kiwibnc/extensions/webchat/kiwibnc_plugin.html"


class ScriptParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.scripts = []
        self._current_script = None

    def handle_starttag(self, tag, attrs):
        if tag.lower() != "script":
            return
        self._current_script = {
            "attrs": dict(attrs),
            "text": "",
        }

    def handle_data(self, data):
        if self._current_script is not None:
            self._current_script["text"] += data

    def handle_endtag(self, tag):
        if tag.lower() == "script" and self._current_script is not None:
            self.scripts.append(self._current_script)
            self._current_script = None


class KiwiBncEntitlementsContractTests(unittest.TestCase):
    def read_module(self):
        self.assertTrue(
            MODULE_PATH.is_file(),
            "Expected RelayBNC entitlements resolver at "
            "kiwibnc/libs/relayos_entitlements.js",
        )
        return MODULE_PATH.read_text()

    def run_node(self, script):
        completed = subprocess.run(
            ["node", "-e", script],
            cwd=REPO_ROOT,
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        return completed.stdout.strip()

    def test_module_file_exists_and_exports_resolver(self):
        text = self.read_module()

        self.assertRegex(text, r"class\s+RelayosEntitlements")
        self.assertRegex(text, r"async\s+init\s*\(")
        self.assertRegex(text, r"async\s+migrateSchema\s*\(")
        self.assertRegex(text, r"async\s+getUserEntitlements\s*\(")
        self.assertRegex(text, r"async\s+getUserCapabilities\s*\(")
        self.assertRegex(text, r"async\s+canQueueOfflineDirectMessage\s*\(")
        self.assertRegex(text, r"async\s+projectUserMetadata\s*\(")
        self.assertRegex(text, r"module\.exports\s*=\s*RelayosEntitlements")
        self.assertIn("module.exports.parseOverlay = parseOverlay", text)

        script = r"""
const RelayosEntitlements = require('./kiwibnc/libs/relayos_entitlements');
if (typeof RelayosEntitlements.parseOverlay !== 'function') {
    throw new Error('Expected parseOverlay to be exported');
}
const overlay = RelayosEntitlements.parseOverlay('users:\n  Alice:\n    - lucky\n');
console.log(JSON.stringify(overlay.users.alice));
"""
        self.assertEqual(json.loads(self.run_node(script)), ["lucky"])

    def test_schema_defines_extension_owned_entitlement_tables(self):
        script = r"""
const RelayosEntitlements = require('./kiwibnc/libs/relayos_entitlements');
const statements = [];
function db() {}
db.raw = async (sql) => {
    statements.push(String(sql).replace(/\s+/g, ' ').trim());
};
(async () => {
    const resolver = new RelayosEntitlements({ db, overlayPath: '' });
    await resolver.migrateSchema();
    console.log(JSON.stringify(statements));
})().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
});
"""
        text = " ".join(json.loads(self.run_node(script)))

        expected_snippets = [
            "CREATE TABLE IF NOT EXISTS `relayos_capabilities`",
            "CREATE TABLE IF NOT EXISTS `relayos_entitlements`",
            "CREATE TABLE IF NOT EXISTS `relayos_entitlement_capabilities`",
            "CREATE TABLE IF NOT EXISTS `relayos_user_entitlements`",
            "COLLATE=utf8mb4_unicode_520_ci",
            "FOREIGN KEY (`wp_user_id`) REFERENCES `wp_users` (`ID`)",
            "FOREIGN KEY (entitlement_key) REFERENCES `relayos_entitlements` (`key`)",
            "source VARCHAR(64) NOT NULL DEFAULT 'system'",
            "source_ref VARCHAR(191) NULL",
            "ALTER TABLE `relayos_user_entitlements` ADD COLUMN IF NOT EXISTS source VARCHAR(64) NOT NULL DEFAULT 'system'",
            "ALTER TABLE `relayos_user_entitlements` ADD COLUMN IF NOT EXISTS source_ref VARCHAR(191) NULL",
            "KEY idx_relayos_user_entitlements_source (source, source_ref)",
            "ON DELETE CASCADE",
        ]
        for snippet in expected_snippets:
            self.assertIn(snippet, text)

    def test_db_capability_mappings_are_authoritative(self):
        script = r"""
const RelayosEntitlements = require('./kiwibnc/libs/relayos_entitlements');
function db() {}
db.raw = async (sql) => {
    if (sql.includes('FROM `relayos_user_entitlements`')) {
        return [[{ key: 'active-subscriber' }]];
    }
    if (sql.includes('FROM `relayos_entitlement_capabilities`')) {
        return [[{ capability_key: 'async_message.receive_from_anyone' }]];
    }
    return [[]];
};
(async () => {
    const resolver = new RelayosEntitlements({ db, overlayPath: '' });
    const capabilities = await resolver.getUserCapabilities({ wp_user_id: 123 });
    console.log(JSON.stringify(capabilities));
})().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
});
"""
        capabilities = json.loads(self.run_node(script))

        self.assertEqual(capabilities, ["async_message.receive_from_anyone"])

    def test_offline_direct_message_policy_allows_recipient_receive_capability(self):
        script = r"""
const fs = require('fs');
const os = require('os');
const path = require('path');
const RelayosEntitlements = require('./kiwibnc/libs/relayos_entitlements');

(async () => {
    const overlayPath = path.join(os.tmpdir(), `relayos-entitlements-${process.pid}.yml`);
    fs.writeFileSync(overlayPath, [
        'users:',
        '  Recipient:',
        '    - early-supporter',
        ''
    ].join('\n'));

    try {
        const resolver = new RelayosEntitlements({ overlayPath });
        await resolver.init();

        const allowed = await resolver.canQueueOfflineDirectMessage(
            { username: 'Sender' },
            { username: 'Recipient' }
        );
        const denied = await resolver.canQueueOfflineDirectMessage(
            { username: 'Sender' },
            { username: 'OtherRecipient' }
        );

        console.log(JSON.stringify({ allowed, denied }));
    } finally {
        fs.unlinkSync(overlayPath);
    }
})().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
});
"""
        policy = json.loads(self.run_node(script))

        self.assertEqual(policy, {"allowed": True, "denied": False})

    def test_defaults_and_overlay_contract_are_present(self):
        text = self.read_module()

        expected_snippets = [
            "RELAYOS_ENTITLEMENTS_OVERLAY",
            "async_message.send_to_offline",
            "async_message.receive_from_anyone",
            "active-subscriber",
            "lucky",
            "parseOverlay",
        ]
        for snippet in expected_snippets:
            self.assertIn(snippet, text)

    def test_overlay_ignores_unknown_top_level_sections(self):
        script = r"""
const RelayosEntitlements = require('./kiwibnc/libs/relayos_entitlements');
const overlay = RelayosEntitlements.parseOverlay(`
users:
  alice:
    - lucky
metadata:
  bob:
    - active-subscriber
`);
console.log(JSON.stringify(overlay.users));
"""
        users = json.loads(self.run_node(script))

        self.assertEqual(users, {"alice": ["lucky"]})
        self.assertNotIn("bob", users)

    def test_metadata_projection_exposes_entitlements_not_capabilities(self):
        text = self.read_module()

        self.assertIn("`entitlement/${key}`", text)
        self.assertNotIn("`capability/${key}`", text)

    def test_webchat_badge_helper_contract_is_present(self):
        self.assertTrue(
            BADGES_HELPER_PATH.is_file(),
            "Expected RelayBNC webchat badge helper at "
            "kiwibnc/extensions/webchat/relayos_badges.js",
        )
        text = BADGES_HELPER_PATH.read_text()

        expected_snippets = [
            "function relayosCountryFlag",
            "function relayosBadgesFromMetadata",
            "geo/country-code",
            "entitlement/lucky",
            "🍀",
            "module.exports",
        ]
        for snippet in expected_snippets:
            self.assertIn(snippet, text)

    def test_webchat_serves_badge_helper(self):
        text = ROUTES_CLIENT_PATH.read_text()

        self.assertIn("kiwi.relayos_badges", text)
        self.assertIn("relayos_badges.js", text)

    def test_webchat_plugin_loads_and_applies_badges(self):
        text = KIWIBNC_PLUGIN_PATH.read_text()
        parser = ScriptParser()
        parser.feed(text)

        external_badge_scripts = [
            script for script in parser.scripts
            if "relayos_badges.js" in script["attrs"].get("src", "")
        ]
        self.assertEqual(
            external_badge_scripts,
            [],
            "Kiwi loads plugin script text only; badge helper must not depend on script src",
        )

        inline_scripts = [
            script["text"] for script in parser.scripts
            if not script["attrs"].get("src")
        ]
        main_script = next(
            script for script in inline_scripts
            if "kiwi.plugin('kiwibnc'" in script
        )
        helper_index = main_script.find("function relayosBadgesFromMetadata")
        apply_index = main_script.find("relayosApplyBadges")

        self.assertNotEqual(helper_index, -1)
        self.assertNotEqual(apply_index, -1)
        self.assertLess(helper_index, apply_index)
        self.assertIn("data-relayos-badges", main_script)


if __name__ == "__main__":
    unittest.main()
