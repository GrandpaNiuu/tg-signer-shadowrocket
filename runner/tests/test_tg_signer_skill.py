import base64
import json
import unittest
from types import SimpleNamespace
from unittest import mock

from runner.skills.base import SkillContext, SkillError
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


class FakeMessage:
    def __init__(self, message_id, *, text="", buttons=()):
        self.id = message_id
        self.text = text
        self.caption = None
        self.clicked = None
        self.reply_markup = None
        if buttons:
            row = [SimpleNamespace(text=value) for value in buttons]
            self.reply_markup = SimpleNamespace(inline_keyboard=[row])

    async def click(self, value):
        self.clicked = value


class FakeApp:
    def __init__(self, histories):
        self.histories = list(histories)

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        return False

    async def get_chat_history(self, _target, limit=20):
        del limit
        history = self.histories.pop(0) if self.histories else []
        for message in history:
            yield message


class GuidedSigner:
    def __init__(self, histories):
        self.app = FakeApp(histories)
        self.sent = None
        self.logged_in = False

    async def login(self, num_of_dialogs=1, print_chat=False):
        self.logged_in = num_of_dialogs == 1 and print_chat is False

    async def send_message(self, target, text, message_thread_id=None):
        self.sent = (target, text, message_thread_id)
        return FakeMessage(1, text=text)


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

    def test_platform_guided_configuration_is_validated_without_legacy_import(self):
        config = json.dumps({
            "kind": "telegram_guided_signin",
            "version": 1,
            "target": "@points_bot",
            "text": "/checkin",
            "button_text": "签到",
            "success_keywords": ["签到成功", "已签到"],
            "wait_seconds": 30,
        })
        values = TgSignerSkill._guided_flow(config)
        self.assertEqual(values["target"], "@points_bot")
        self.assertEqual(values["text"], "/checkin")
        self.assertEqual(values["button_text"], "签到")
        self.assertEqual(values["success_keywords"], ["签到成功", "已签到"])
        self.assertEqual(values["wait_seconds"], 30)

    def test_unrecognized_json_remains_a_legacy_tg_signer_config(self):
        self.assertIsNone(TgSignerSkill._guided_flow('{"sign_at":"0 8 * * *"}'))


class GuidedSignInExecutionTests(unittest.IsolatedAsyncioTestCase):
    async def test_guided_flow_sends_command_clicks_button_and_confirms_reply(self):
        button_message = FakeMessage(2, text="请选择操作", buttons=("每日签到", "个人中心"))
        success_message = FakeMessage(3, text="签到成功，获得 10 积分")
        signer = GuidedSigner([[button_message], [success_message]])
        flow = {
            "target": "@points_bot",
            "text": "/start",
            "button_text": "签到",
            "success_keywords": ["签到成功"],
            "wait_seconds": 30,
            "message_thread_id": None,
        }

        with mock.patch("runner.skills.tg_signer.asyncio.sleep", new=mock.AsyncMock()):
            result = await TgSignerSkill()._execute_guided(signer, flow)

        self.assertTrue(signer.logged_in)
        self.assertEqual(signer.sent, ("@points_bot", "/start", None))
        self.assertEqual(button_message.clicked, "每日签到")
        self.assertTrue(result["button_clicked"])
        self.assertTrue(result["success_confirmed"])
        self.assertIn("签到成功", result["matched_reply"])

    async def test_timeout_is_ambiguous_and_never_marked_retryable(self):
        signer = GuidedSigner([])
        flow = {
            "target": "@points_bot",
            "text": "/start",
            "button_text": "签到",
            "success_keywords": [],
            "wait_seconds": 5,
            "message_thread_id": None,
        }
        fake_loop = mock.Mock()
        fake_loop.time.side_effect = [0, 6]

        with mock.patch("runner.skills.tg_signer.asyncio.get_running_loop", return_value=fake_loop):
            with self.assertRaises(SkillError) as raised:
                await TgSignerSkill()._execute_guided(signer, flow)

        self.assertEqual(raised.exception.code, "guided_signin_timeout")
        self.assertTrue(raised.exception.ambiguous)
        self.assertFalse(raised.exception.retryable)


if __name__ == "__main__":
    unittest.main()
