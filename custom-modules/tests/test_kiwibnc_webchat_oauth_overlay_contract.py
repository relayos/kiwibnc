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
        ]
        for snippet in expected_snippets:
            self.assertIn(snippet, text)

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
