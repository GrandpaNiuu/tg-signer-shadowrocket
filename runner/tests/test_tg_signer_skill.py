import base64
import unittest
from unittest import mock

from runner.skills.base import SkillContext
from runner.skills.tg_signer import TgSignerSkill


class FakeSigner:
    def __init__(self):
        self.imported = None
        self.ran = None

    def import_(self, value):
        self.imported = value

    def run_once(self, count):
        self.ran = count
        return "coroutine-placeholder"

    def app_run(self, coroutine):
        self.coroutine = coroutine


class TgSignerSkillTests(unittest.TestCase):
    def test_import_uses_the_same_required_task_name_then_runs_once(self):
        fake = FakeSigner()
        seen = {}

        def build(context, *, task_name, workspace):
            seen["task_name"] = task_name
            return fake

        config = '{"sign_at":"0 8 * * *"}'
        context = SkillContext(
            account_id="account-1",
            task_id="task-1",
            secrets={"session_string": "secret-session"},
        )
        with mock.patch("runner.skills.tg_signer.build_signer", side_effect=build):
            result = TgSignerSkill().execute(
                context,
                {
                    "task_name": "legacy-task",
                    "import_blob": base64.b64encode(config.encode()).decode(),
                    "num_of_dialogs": 75,
                },
            )

        self.assertEqual(seen["task_name"], "legacy-task")
        self.assertEqual(fake.imported, config)
        self.assertEqual(fake.ran, 75)
        self.assertTrue(result.data["completed"])


if __name__ == "__main__":
    unittest.main()
