import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]


class WorkflowSecurityTests(unittest.TestCase):
    def test_task_workflow_exposes_only_run_id_and_two_base_secrets(self):
        text = (ROOT / ".github/workflows/task-runner.yml").read_text(encoding="utf-8")
        secrets = set(re.findall(r"secrets\.([A-Z0-9_]+)", text))
        self.assertEqual(secrets, {"WORKER_URL", "WORKER_OIDC_AUDIENCE"})
        input_block = text.split("inputs:", 1)[1].split("permissions:", 1)[0]
        declared = re.findall(r"^\s{6}([a-z0-9_]+):\s*$", input_block, re.MULTILINE)
        self.assertEqual(declared, ["run_id"])
        self.assertNotIn("TG_SESSION_STRING", text)
        self.assertIn("id-token: write", text)

    def test_dependency_is_pinned_to_immutable_audit_commit(self):
        text = (ROOT / "runner/requirements.txt").read_text(encoding="utf-8")
        self.assertIn("@95a98572dcef5e0b96fc17e6a2331c8f4dc9d886", text)
        self.assertNotIn("@main", text)


if __name__ == "__main__":
    unittest.main()
