import unittest

from runner.models import TaskSpec, ValidationError


class TaskSpecTests(unittest.TestCase):
    def test_parses_worker_claim_and_normalizes_legacy_task_fields(self):
        claim = {
            "run": {"id": "run-1"},
            "task": {
                "id": "task-1",
                "skill": "send_text",
                "bot": "@example_bot",
                "command": "/checkin",
                "thread": "7",
                "delete_after": "3",
                "retry": 2,
                "timeout": 45,
            },
            "account": {
                "id": "account-1",
                "session_string": "session-secret",
                "api_id": "12345",
                "api_hash": "hash-secret",
                "proxy": "socks5://user:password@example:1080",
            },
        }

        spec = TaskSpec.from_claim(claim, expected_run_id="run-1")

        self.assertEqual(spec.skill, "send_text")
        self.assertEqual(spec.params["target"], "@example_bot")
        self.assertEqual(spec.params["text"], "/checkin")
        self.assertEqual(spec.params["message_thread_id"], 7)
        self.assertEqual(spec.params["delete_after"], 3)
        self.assertEqual(spec.max_attempts, 3)
        self.assertEqual(spec.timeout_seconds, 45)
        self.assertEqual(spec.secrets["session_string"], "session-secret")

    def test_rejects_unknown_skill(self):
        with self.assertRaises(ValidationError):
            TaskSpec.from_claim(
                {
                    "run": {"id": "run-1"},
                    "task": {"id": "task-1", "skill": "shell"},
                    "account": {"id": "account-1", "session_string": "s"},
                },
                expected_run_id="run-1",
            )

    def test_rejects_run_id_mismatch(self):
        with self.assertRaises(ValidationError):
            TaskSpec.from_claim(
                {
                    "run": {"id": "another-run"},
                    "task": {"id": "task-1", "skill": "send_text"},
                    "account": {"id": "account-1", "session_string": "s"},
                },
                expected_run_id="run-1",
            )

    def test_legacy_task_mode_uses_command_as_tg_signer_task_name(self):
        spec = TaskSpec.from_claim(
            {
                "run": {"id": "run-1"},
                "task": {
                    "id": "task-1",
                    "skill": "task",
                    "command": "legacy-sign",
                },
                "account": {"id": "account-1", "session_string": "session"},
            },
            expected_run_id="run-1",
        )
        self.assertEqual(spec.skill, "tg_signer")
        self.assertEqual(spec.params["task_name"], "legacy-sign")


if __name__ == "__main__":
    unittest.main()
