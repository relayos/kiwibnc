import re
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = REPO_ROOT / "kiwibnc/worker/messagestores/mariadb.js"
IMPORT_TOOL_PATH = REPO_ROOT / "kiwibnc/tools/mariadb_jsonl_to_loadfile.js"


class KiwiBncMariaDbMessageStoreContractTests(unittest.TestCase):
    def read_module(self):
        self.assertTrue(
            MODULE_PATH.is_file(),
            "Expected RelayBNC MariaDB message store at "
            "kiwibnc/worker/messagestores/mariadb.js",
        )
        return MODULE_PATH.read_text()

    def test_readme_records_fork_split_findings(self):
        text = (REPO_ROOT / "kiwibnc/README.md").read_text()
        expected_snippets = [
            "Fork Split Findings",
            "Keep in the KiwiBNC fork for now",
            "Move later",
            "Move now",
            "MariaDB message history storage",
            "`logging.custom`",
            "without more divergence from upstream KiwiBNC",
        ]
        for snippet in expected_snippets:
            self.assertIn(snippet, text)

    def test_module_file_exists_and_exports_store(self):
        text = self.read_module()
        self.assertIn("MariaDbMessageStore", text)
        self.assertRegex(text, r"module\.exports\s*=\s*MariaDbMessageStore")

    def test_init_awaits_schema_migration(self):
        text = self.read_module()
        self.assertRegex(text, r"async\s+init\s*\(")
        self.assertRegex(text, r"await\s+[^;\n]*migrat\w*\s*\(")

    def test_uses_bnc_messages_by_default(self):
        text = self.read_module()
        self.assertIn("bnc_messages", text)
        self.assertRegex(
            text,
            r"(?:tableName|table)\s*[:=]\s*[^;\n]*['\"]bnc_messages['\"]",
        )

    def test_schema_ddl_uses_bnc_prefix_and_core_foreign_keys(self):
        text = self.read_module()
        ddl = re.sub(r"\s+", " ", text)
        expected_snippets = [
            "CREATE TABLE IF NOT EXISTS bnc_messages",
            "FOREIGN KEY",
            "REFERENCES bnc_users",
            "REFERENCES bnc_user_networks",
        ]
        for snippet in expected_snippets:
            self.assertIn(snippet, ddl)

    def test_validates_configurable_sql_identifiers(self):
        text = self.read_module()
        expected_snippets = [
            "this.validateIdentifier(this.tableName)",
            "this.validateIdentifier(this.usersTable)",
            "this.validateIdentifier(this.networksTable)",
            "this.validateIdentifier(this.collation)",
        ]
        for snippet in expected_snippets:
            self.assertIn(snippet, text)

    def test_fk_defaults_follow_configured_database_table_prefix(self):
        text = self.read_module()
        self.assertIn("const databaseConf = config.get('database', {})", text)
        self.assertIn("const tablePrefix = storeConf.table_prefix || databaseConf.table_prefix || 'bnc_'", text)
        self.assertIn("`${tablePrefix}users`", text)
        self.assertIn("`${tablePrefix}user_networks`", text)

    def test_msgid_queries_use_time_and_id_boundaries(self):
        text = self.read_module()
        expected_snippets = [
            "lookupMsgIdBoundary",
            "boundary.time",
            "boundary.id",
            "(time > ? OR (time = ? AND id > ?))",
            "(time < ? OR (time = ? AND id <= ?))",
        ]
        for snippet in expected_snippets:
            self.assertIn(snippet, text)

    def test_exposes_queued_writes_and_error_logging(self):
        text = self.read_module()
        self.assertRegex(text, r"(?:queue|queued|enqueue|writeQueue)")
        self.assertRegex(text, r"(?:flush|drain|process)[A-Za-z]*Queue")
        self.assertRegex(text, r"(?:logger|log)\.error\s*\(")

    def test_does_not_contain_legacy_tier_sku_or_upgrade_logic(self):
        text = self.read_module().lower()
        legacy_terms = [
            "sku",
            "tier",
            "premium",
            "subscription",
            "upgrade",
            "pro plan",
            "pro_plan",
            "is_pro",
        ]
        for term in legacy_terms:
            self.assertNotIn(term, text)

    def test_jsonl_import_tool_documents_load_data_format(self):
        self.assertTrue(
            IMPORT_TOOL_PATH.is_file(),
            "Expected JSONL import helper at kiwibnc/tools/mariadb_jsonl_to_loadfile.js",
        )
        text = IMPORT_TOOL_PATH.read_text()
        expected_snippets = [
            "LOAD DATA",
            "buffer_lower",
            "buffer-normalize",
            "JSON.parse",
            "escapeField",
            "bnc_messages",
        ]
        for snippet in expected_snippets:
            self.assertIn(snippet, text)

    def test_kiwibnc_tree_does_not_contain_legacy_db_credentials(self):
        for path in (REPO_ROOT / "kiwibnc").rglob("*"):
            if path.is_file():
                text = path.read_text(errors="ignore")
                self.assertNotIn("bADm2me5oqSJj86fYZM3", text, path)
                self.assertNotIn("100.68.254.62", text, path)
                self.assertNotIn("100.99.100.7", text, path)


if __name__ == "__main__":
    unittest.main()
