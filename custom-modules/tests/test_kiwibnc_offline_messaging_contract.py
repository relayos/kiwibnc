import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = REPO_ROOT / "kiwibnc/extensions/offline-messaging/index.js"


class KiwiBncOfflineMessagingContractTests(unittest.TestCase):
    def read_module(self):
        self.assertTrue(
            MODULE_PATH.is_file(),
            "Expected offline messaging extension at kiwibnc/extensions/offline-messaging/index.js",
        )
        return MODULE_PATH.read_text()

    def test_extension_hooks_message_from_client(self):
        text = self.read_module()

        self.assertIn("module.exports.init", text)
        self.assertIn("hooks.on('message_from_client'", text)
        self.assertIn("handleMessageFromClient", text)

    def test_extension_only_handles_privmsg_direct_messages(self):
        text = self.read_module()

        for snippet in [
            "event.message.command.toUpperCase() !== 'PRIVMSG'",
            "isChannelTarget",
            "target.toLowerCase() === '*bnc'",
            "target.toLowerCase() === senderUsername.toLowerCase()",
        ]:
            self.assertIn(snippet, text)

        self.assertNotIn("commands.NOTICE", text)
        self.assertNotIn("INSERT INTO bnc_messages", text)

    def test_extension_uses_bnc_identity_and_network_lookup(self):
        text = self.read_module()

        for snippet in [
            "lookupRecipient",
            "dbUsers('users')",
            "dbUsers('user_networks')",
            "wp_user_id",
            "RelayOS",
            "findUsersOutgoingConnection",
        ]:
            self.assertIn(snippet, text)

        self.assertNotIn(".where('users.username', 'LIKE', target)", text)
        self.assertIn(".where('users.username', target)", text)

    def test_extension_only_treats_connected_recipient_upstream_as_online(self):
        text = self.read_module()

        self.assertIn("const upstream = app.cons.findUsersOutgoingConnection", text)
        self.assertIn("upstream.state.connected", text)

    def test_extension_calls_message_store_helper_and_acknowledges_sender(self):
        text = self.read_module()

        for snippet in [
            "storeOfflineDirectMessage",
            "queued offline message for",
            "failed to queue offline message for",
            "event.preventDefault()",
            "event.passthru = false",
            "msgIdGenerator.generateId()",
        ]:
            self.assertIn(snippet, text)


if __name__ == "__main__":
    unittest.main()
