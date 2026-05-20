import re
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
WEBCHAT_ROOT = REPO_ROOT / "kiwibnc/extensions/webchat"


class KiwiBncWebchatOauthOverlayContractTests(unittest.TestCase):
    def read_overlay(self, filename):
        path = WEBCHAT_ROOT / filename
        self.assertTrue(path.is_file(), f"Expected KiwiBNC webchat overlay file at {path.relative_to(REPO_ROOT)}")
        return path.read_text()

    def test_expected_webchat_overlay_files_exist(self):
        for relpath in [
            "kiwibnc/extensions/webchat/routes_oauth.js",
            "kiwibnc/extensions/webchat/routes_platform_link.js",
            "kiwibnc/extensions/webchat/index.js",
            "kiwibnc/extensions/webchat/routes_client.js",
            "kiwibnc/extensions/webchat/kiwibnc_plugin.html",
        ]:
            self.assertTrue((REPO_ROOT / relpath).is_file(), relpath)

    def test_routes_oauth_exports_contract_and_maps_wordpress_identity(self):
        text = self.read_overlay("routes_oauth.js")

        self.assertRegex(text, r"module\.exports\s*=\s*\{[^}]*registerRoutes")
        self.assertRegex(text, r"module\.exports\s*=\s*\{[^}]*getClientConfig")
        self.assertRegex(text, r"module\.exports\s*=\s*\{[^}]*buildOauthConfig")

        expected_snippets = [
            "userInfo.user_login",
            "OAuth userinfo missing user_login",
            "OAuth user_login is not a valid BNC username",
            "wp_user_id",
            "identity.wpUserId",
            "setUserWordPressId",
            "tenant WordPress",
            "RELAYOS_TENANT_ID",
        ]
        for snippet in expected_snippets:
            self.assertIn(snippet, text)

    def test_bnc_wordpress_provisioning_helper_exists(self):
        text = self.read_overlay("provision_bnc.js")

        for snippet in [
            "tenant WordPress",
            "RELAYOS_TENANT_ID",
            "relayos-tenant",
            "async function ensureBncWordPressProvisioning",
            "module.exports",
            "wp_users",
            "wp_user_id",
            "wordpress_users_bnc_after_insert",
            "wordpress_users_bnc_after_update",
            "wordpress_users_bnc_after_delete",
            "ON DELETE CASCADE",
            "ON UPDATE CASCADE",
            "bcrypt_hash(CONCAT('oauth-unusable-'",
        ]:
            self.assertIn(snippet, text)
        self.assertNotIn("platform_subject_id", text)

    def test_bnc_provisioning_installs_relaybnc_sasl_credential_table(self):
        text = self.read_overlay("provision_bnc.js")

        for snippet in [
            "relayos_bnc_sasl_credentials",
            "credential_hash",
            "source VARCHAR(64) NOT NULL DEFAULT 'kiwibnc-oauth'",
            "FOREIGN KEY (wp_user_id) REFERENCES \\`wp_users\\` (\\`ID\\`)",
            "bnc_sasl_credentials_wp_user_id_fk",
        ]:
            self.assertIn(snippet, text)

    def test_oauth_networks_are_configured_for_upstream_sasl(self):
        routes = self.read_overlay("routes_oauth.js")
        provisioning = self.read_overlay("provision_bnc.js")

        for snippet in [
            "generateRelayBncSaslSecret",
            "ensureRelayBncSaslCredential",
            "sasl_account",
            "sasl_pass",
            "network.sasl_account = username",
            "network.sasl_pass = saslSecret",
            "await network.save()",
        ]:
            self.assertIn(snippet, routes)

        for snippet in [
            "sasl_account, sasl_pass",
            "RELAYOS_BNC_SASL_UNPROVISIONED",
        ]:
            self.assertIn(snippet, provisioning)

    def test_bnc_provisioning_does_not_mutate_wordpress_schema(self):
        text = self.read_overlay("provision_bnc.js")

        forbidden = [
            "ALTER TABLE wp_users",
            "CREATE INDEX",
            "ADD COLUMN",
            "MODIFY COLUMN wp_",
        ]
        for snippet in forbidden:
            self.assertNotIn(snippet, text)

    def test_bnc_provisioning_installs_bnc_owned_foreign_keys(self):
        text = self.read_overlay("provision_bnc.js")

        for snippet in [
            "bnc_users_wp_user_id_fk",
            "bnc_user_networks_user_id_fk",
            "bnc_user_tokens_user_id_fk",
            "REFERENCES `wp_users` (`ID`)",
            "REFERENCES",
            "ON DELETE CASCADE",
        ]:
            self.assertIn(snippet, text)

    def test_routes_oauth_uses_provisioning_helper(self):
        text = self.read_overlay("routes_oauth.js")

        self.assertIn("ensureBncWordPressProvisioning", text)
        self.assertIn("require('./provision_bnc')", text)
        self.assertRegex(text, r"module\.exports\s*=\s*\{[^}]*ensureBncWordPressProvisioning")

    def test_platform_link_route_contract_is_tenant_bound(self):
        text = self.read_overlay("routes_platform_link.js")
        index = self.read_overlay("index.js")

        for snippet in [
            "registerPlatformLinkRoutes",
            "buildPlatformLinkConfig",
            "syncPlatformEntitlementSnapshot",
            "relayos_platform_links",
            "platform_subject_id",
            "tenant WordPress",
            "RELAYOS_TENANT_ID",
            "RELAYOS_PLATFORM_ISSUER",
            "RELAYOS_PLATFORM_ENTITLEMENT_SNAPSHOT_URL",
            "No tenant user session",
        ]:
            self.assertIn(snippet, text)

        self.assertIn("require('./routes_platform_link')", index)
        self.assertIn("registerPlatformLinkRoutes(app)", index)

    def test_routes_client_disables_public_registration_when_oauth_is_enabled(self):
        text = self.read_overlay("routes_client.js")

        self.assertIn("const oauthEnabled = !!(oauthClientConf && oauthClientConf.login_url)", text)
        self.assertRegex(text, r"public_register\s*:\s*oauthEnabled\s*\?\s*false")
        self.assertRegex(text, r"startupOptions\.public_register\s*=\s*oauthEnabled\s*\?")
        self.assertIn("if (oauthEnabled || !app.conf.get('webchat.public_register', false))", text)
        self.assertIn("config.oauth = oauthClientConf", text)

    def test_plugin_html_contains_oauth_login_ux_and_localstorage_handoff(self):
        text = self.read_overlay("kiwibnc_plugin.html")

        expected_snippets = [
            "oauthEnabled",
            "Login with {{ oauthProvider }}",
            "this.oauthConfig.login_url",
            "getOauthLogin()",
            "window.localStorage.getItem('kiwibnc_oauth_login')",
            "window.localStorage.removeItem('kiwibnc_oauth_login')",
        ]
        for snippet in expected_snippets:
            self.assertIn(snippet, text)


if __name__ == "__main__":
    unittest.main()
