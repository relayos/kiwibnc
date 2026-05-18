import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


class KiwiOverlayContractTests(unittest.TestCase):
    def test_identity_plugin_is_debranded_and_local_asset_only(self):
        text = (REPO_ROOT / 'kiwiirc/static/plugins/plugin-relayos-identity.js').read_text()
        self.assertNotIn('chat.isexychat.com', text)
        self.assertNotIn('isexychat', text.lower())
        self.assertIn('identity/', text)
        self.assertIn('intent/', text)

    def test_metadata_plugin_uses_canonical_namespaces(self):
        text = (
            REPO_ROOT / 'kiwiirc/static/plugins/plugin-relayos-metadata.js'
        ).read_text()
        expected_snippets = [
            'RELAYOS_METADATA_NAMESPACES = [',
            'identity/',
            'intent/',
            'trust/',
            'entitlement/',
            'geo/',
            'connection/',
            'ensureRelayosRootState',
            "kiwi.on('network.connecting'",
            'requestCap(',
            "kiwi.on('irc.registered'",
            "raw('METADATA'",
            "kiwi.on('irc.raw.METADATA'",
        ]
        for snippet in expected_snippets:
            self.assertIn(snippet, text)
        self.assertNotIn('chat.isexychat.com', text)

    def test_identity_plugin_renders_metadata_driven_ui(self):
        text = (REPO_ROOT / 'kiwiirc/static/plugins/plugin-relayos-identity.js').read_text()
        expected_snippets = [
            'RELAYOS_GEO_COUNTRY_CODE_KEY',
            'intent/',
            'identity/',
            'flag',
            'badge',
            "kiwi.on('message.render'",
            'MutationObserver',
            'kiwi-nicklist-user',
        ]
        for snippet in expected_snippets:
            self.assertIn(snippet, text)

    def test_ui_plugins_do_not_carry_legacy_brand_names(self):
        for relpath in [
            'kiwiirc/static/plugins/plugin-relayos-servername.js',
            'kiwiirc/static/plugins/plugin-relayos-kicknotice.js',
        ]:
            text = (REPO_ROOT / relpath).read_text().lower()
            self.assertNotIn('isc-', text)
            self.assertNotIn('isexychat', text)

    def test_analytics_plugin_is_generic(self):
        text = (REPO_ROOT / 'kiwiirc/static/plugins/plugin-relayos-analytics.js').read_text()
        self.assertIn('analytics', text.lower())
        self.assertNotIn('G-9VSP3HR9NF', text)
        self.assertNotIn('UA-15123508-19', text)

    def test_microfunnel_plugin_uses_generic_intent_keys(self):
        text = (REPO_ROOT / 'kiwiirc/static/plugins/plugin-relayos-microfunnel.js').read_text()
        self.assertIn('intent/', text)
        self.assertIn('customer-type', text)
        self.assertIn('inquiry-type', text)
        self.assertIn('topic-tags', text)
        self.assertIn('settings.relayosTenant', text)
        self.assertIn('dimensions', text)
        self.assertIn("kiwi.on('ready'", text)
        self.assertIn('MutationObserver', text)
        self.assertIn('kiwi-welcome-simple', text)
        self.assertIn('.relayos-microfunnel__choice:has(input:checked)', text)
        self.assertIn("container.addEventListener('click'", text)
        self.assertIn("container.addEventListener('change'", text)
        self.assertIn("container.dataset.relayosWired = 'true'", text)
        self.assertNotIn('i like women', text.lower())

    def test_microfunnel_plugin_targets_compact_welcome_layout_and_rebinds(self):
        text = (REPO_ROOT / 'kiwiirc/static/plugins/plugin-relayos-microfunnel.js').read_text()
        expected_snippets = [
            '.relayos-microfunnel{',
            'max-width:min(100%,32rem)',
            '.relayos-microfunnel__choices{',
            'grid-template-columns:1fr',
            '.relayos-microfunnel__choice{',
            'min-height:2.4rem',
            "container.dataset.relayosWired = 'false'",
            "delete container.dataset.relayosWired",
            'requestAnimationFrame(() => relayosMicrofunnelMount(kiwi))',
            'kiwi.Vue.observable',
            'kiwi.Vue.set(draft,',
            'relayosMicrofunnelProjectDraftToSelf',
            '.kiwi-welcome-simple-start',
        ]
        for snippet in expected_snippets:
            self.assertIn(snippet, text)

    def test_identity_plugin_populates_first_user_popover(self):
        text = (REPO_ROOT / 'kiwiirc/static/plugins/plugin-relayos-identity.js').read_text()
        expected_snippets = [
            "kiwi.addUi('userbox_info'",
            'relayos-userbox-section',
            'Display',
            'Customer',
            'Inquiry',
            'Trust',
            'Region',
            'Entitlements',
            'intent/customer-type',
            'intent/inquiry-type',
            'trust/verification-tier',
            'geo/country-name',
        ]
        for snippet in expected_snippets:
            self.assertIn(snippet, text)

    def test_identity_plugin_falls_back_to_local_intent_draft_for_self(self):
        text = (REPO_ROOT / 'kiwiirc/static/plugins/plugin-relayos-identity.js').read_text()
        expected_snippets = [
            '$relayosIntentDraft',
            'pluginProps.userbox.isSelf',
            "props: ['user', 'network', 'buffer', 'sidebarState', 'pluginProps']",
            'intent/customer-type',
            'intent/inquiry-type',
            'intent/topic-tags',
        ]
        for snippet in expected_snippets:
            self.assertIn(snippet, text)

    def test_metadata_plugin_suppresses_raw_metadata_notice_noise(self):
        text = (
            REPO_ROOT / 'kiwiirc/static/plugins/plugin-relayos-metadata.js'
        ).read_text()
        expected_snippets = [
            'overlayRelayosDraftIntentForSelf',
            'network.currentUser()',
            "$relayosIntentDraft",
            "grouped.intent['customer-type']",
            "grouped.intent['inquiry-type']",
            "grouped.intent['topic-tags']",
            "kiwi.on('message.render'",
            'message.ignore = true',
            'connection/hash',
            'connection/verified',
            'geo/country-code',
            'geo/country-name',
            'METADATA',
        ]
        for snippet in expected_snippets:
            self.assertIn(snippet, text)

    def test_expected_overlay_files_exist(self):
        expected = {
            "kiwiirc/static/plugins/plugin-relayos-metadata.js": "relayos-metadata",
            "kiwiirc/static/plugins/plugin-relayos-identity.js": "relayos-identity",
            "kiwiirc/static/plugins/plugin-relayos-servername.js": "relayos-servername",
            "kiwiirc/static/plugins/plugin-relayos-kicknotice.js": "relayos-kicknotice",
            "kiwiirc/static/plugins/plugin-relayos-analytics.js": "relayos-analytics",
            "kiwiirc/static/plugins/plugin-relayos-microfunnel.js": "relayos-microfunnel",
        }

        required_files = [
            "kiwiirc/README.md",
            *expected.keys(),
            "kiwiirc/static/themes/relayos/theme.css",
        ]

        for relpath in required_files:
            self.assertTrue((REPO_ROOT / relpath).is_file(), relpath)

        for relpath, plugin_name in expected.items():
            contents = (REPO_ROOT / relpath).read_text()
            self.assertIn("kiwi.plugin(", contents, relpath)
            self.assertIn(plugin_name, contents, relpath)

    def test_index_overlay_shows_relayos_build_version(self):
        text = (REPO_ROOT / "kiwiirc/index.html").read_text()
        self.assertIn("RelayOS Kiwi", text)
        self.assertIn("VERSIONSTRING", text)
        self.assertIn('id="relayos-build-stamp"', text)
        self.assertNotIn("Version unknown", text)

    def test_relayos_theme_uses_brand_tokens_only(self):
        text = (REPO_ROOT / "kiwiirc/static/themes/relayos/theme.css").read_text().lower()
        expected_snippets = [
            ':root',
            '--brand-primary:',
            '--brand-default-bg:',
            '.u-form',
            '.kiwi-statebrowser',
            '.kiwi-sidebar',
            '.kiwi-container-content',
            '.kiwi-header',
            '.kiwi-messagelist',
            'relayos staging',
            '.kiwi-welcome-simple-form',
            '.relayos-userbox-section',
            'max-width:min(100%,36rem)',
            'grid-template-columns:1fr',
        ]
        for snippet in expected_snippets:
            self.assertIn(snippet, text)
        self.assertNotIn('chat.isexychat.com', text)
        self.assertNotIn('chat.bdsmlr.com', text)
        self.assertNotIn('isexychat', text)

    def test_kicknotice_plugin_handles_error_and_kick(self):
        text = (REPO_ROOT / 'kiwiirc/static/plugins/plugin-relayos-kicknotice.js').read_text()
        self.assertIn("kiwi.on('irc.raw.ERROR'", text)
        self.assertIn("kiwi.on('irc.raw.KICK'", text)
        self.assertIn('overlay', text.lower())
        self.assertNotIn('isc-', text.lower())

    def test_servername_plugin_renames_server_tab(self):
        text = (REPO_ROOT / 'kiwiirc/static/plugins/plugin-relayos-servername.js').read_text()
        self.assertIn('Server Messages', text)
        self.assertIn("kiwi.on('message.render'", text)
