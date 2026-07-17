import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


class WorkflowSafetyTests(unittest.TestCase):
    def test_third_party_actions_are_pinned_to_full_commits(self) -> None:
        workflows = "\n".join(
            path.read_text(encoding="utf-8")
            for path in (ROOT / ".github/workflows").glob("*.yml")
        )
        uses = re.findall(r"uses:\s+([^\s#]+)", workflows)
        self.assertTrue(uses)
        for action in uses:
            with self.subTest(action=action):
                self.assertRegex(action, r"@[0-9a-f]{40}$")

    def test_legacy_workflow_is_reproducible_and_redacts_live_output(self) -> None:
        workflow = (ROOT / ".github/workflows/daily-checkin.yml").read_text(encoding="utf-8")

        self.assertIn("95a98572dcef5e0b96fc17e6a2331c8f4dc9d886", workflow)
        self.assertNotIn("git+https://github.com/amchii/tg-signer.git\"", workflow)
        self.assertIn("python -u scripts/redact.py", workflow)
        self.assertIn("concurrency:", workflow)

    def test_worker_deploy_only_auto_runs_from_main_and_pins_wrangler(self) -> None:
        workflow = (ROOT / ".github/workflows/deploy-worker.yml").read_text(encoding="utf-8")

        self.assertIn("branches:", workflow)
        self.assertIn('- "main"', workflow)
        self.assertNotIn("wranglerVersion: latest", workflow)
        migration = "d1 migrations apply DB --remote --config worker/wrangler.toml"
        self.assertIn(migration, workflow)
        self.assertLess(workflow.index(migration), workflow.index("command: deploy --config worker/wrangler.toml"))
        self.assertIn("needs: verify", workflow)
        self.assertIn("npm test --prefix worker", workflow)

    def test_session_string_files_are_ignored(self) -> None:
        ignore = (ROOT / ".gitignore").read_text(encoding="utf-8")
        self.assertIn("*.session_string", ignore)

    def test_legacy_migration_defaults_to_presence_only_and_uses_oidc(self) -> None:
        workflow = (ROOT / ".github/workflows/migrate-legacy.yml").read_text(encoding="utf-8")

        self.assertIn("id-token: write", workflow)
        self.assertIn("default: false", workflow)
        self.assertIn("python scripts/migrate_legacy.py --apply", workflow)
        self.assertNotIn("echo $TG_SESSION", workflow)
        checkout_section, remainder = workflow.split("- name: Import legacy configuration", maxsplit=1)
        import_section, summary_section = remainder.split(
            "- name: Record safe migration summary", maxsplit=1
        )
        self.assertNotIn("TG_SESSION_STRING:", checkout_section)
        self.assertNotIn("TG_API_HASH:", checkout_section)
        self.assertIn("TG_SESSION_STRING:", import_section)
        for name in ("TG_API_ID", "TG_API_HASH", "TG_API_ID_2", "TG_API_HASH_2"):
            with self.subTest(name=name):
                self.assertIn(f"{name}: ${{{{ secrets.{name} }}}}", import_section)
                self.assertNotIn(f"{name}:", summary_section)
        self.assertIn("Configure WORKER_OIDC_AUDIENCE", workflow)

    def test_pages_deploy_is_main_only_and_pins_wrangler(self) -> None:
        workflow = (ROOT / ".github/workflows/deploy-admin.yml").read_text(encoding="utf-8")

        self.assertIn('- "main"', workflow)
        self.assertIn('wranglerVersion: "4.94.0"', workflow)
        self.assertIn("needs: verify", workflow)
        self.assertIn("npm test --prefix admin", workflow)


if __name__ == "__main__":
    unittest.main()
