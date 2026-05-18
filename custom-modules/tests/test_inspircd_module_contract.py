import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


class InspircdModuleContractTests(unittest.TestCase):
    def test_connectionhash_verify_uses_inspircd_v4_module_api(self):
        text = (
            REPO_ROOT
            / "inspircd"
            / "src"
            / "modules"
            / "extra"
            / "m_connectionhash_verify.cpp"
        ).read_text()

        self.assertNotIn("Version GetVersion()", text)
        self.assertNotIn("return Version(", text)
        self.assertIn('Module(VF_VENDOR | VF_OPTCOMMON, "Verifies connection/hash', text)


if __name__ == "__main__":
    unittest.main()
