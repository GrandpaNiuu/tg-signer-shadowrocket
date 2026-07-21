import unittest
from types import SimpleNamespace
from unittest import mock

from runner.skills.base import SkillError, SkillValidationError
from runner.skills.bot_flow import BotFlowSkill


class FakeMessage:
    def __init__(self, message_id, *, text="", buttons=(), outgoing=False):
        self.id = message_id
        self.text = text
        self.caption = None
        self.outgoing = outgoing
        self.reply_markup = None
        self.clicked = None
        if buttons:
            row = [SimpleNamespace(text=value, callback_data=value.encode(), url=None, login_url=None,
                                   web_app=None, switch_inline_query=None,
                                   switch_inline_query_current_chat=None, callback_game=None, pay=None)
                   for value in buttons]
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

    async def get_chat_history(self, _target, limit=50):
        del limit
        history = self.histories.pop(0) if self.histories else []
        for item in history:
            yield item


class FakeSigner:
    def __init__(self, histories):
        self.app = FakeApp(histories)
        self.sent = []
        self.logged_in = False
        self.loop = None

    async def login(self, num_of_dialogs=1, print_chat=False):
        self.logged_in = num_of_dialogs == 1 and print_chat is False

    async def send_message(self, target, text, message_thread_id=None):
        self.sent.append((target, text, message_thread_id))
        return FakeMessage(1, text=text, outgoing=True)


class BotFlowValidationTests(unittest.TestCase):
    def test_rejects_missing_step_timeout_and_arbitrary_actions(self):
        skill = BotFlowSkill()
        with self.assertRaises(SkillValidationError):
            skill.validate({"target": "@example_bot", "steps": [{"action": "send", "text": "/start"}]})
        with self.assertRaises(SkillValidationError):
            skill.validate({"target": "@example_bot", "steps": [{"action": "shell", "timeout": 5}]})

    def test_limits_step_count(self):
        steps = [{"action": "send", "text": "/start", "timeout": 1}] * 21
        with self.assertRaises(SkillValidationError):
            BotFlowSkill().validate({"target": "@example_bot", "steps": steps})


class BotFlowExecutionTests(unittest.IsolatedAsyncioTestCase):
    async def test_flow_sends_waits_clicks_and_confirms(self):
        button = FakeMessage(2, text="请选择", buttons=("每日签到", "设置"))
        success = FakeMessage(3, text="签到成功")
        signer = FakeSigner([[], [button], [success]])
        values = BotFlowSkill().validate({
            "target": "@example_bot",
            "steps": [
                {"action": "send", "text": "/start", "timeout": 10},
                {"action": "wait_message", "match": "请选择", "timeout": 10},
                {"action": "click_button", "button": "签到", "timeout": 10},
                {"action": "wait_message", "match_any": ["成功", "完成"], "timeout": 10},
            ],
        })
        with mock.patch("runner.skills.telegram_primitives.asyncio.sleep", new=mock.AsyncMock()):
            result = await BotFlowSkill()._execute_flow(signer, values)
        self.assertTrue(result.data["completed"])
        self.assertEqual(result.data["steps_completed"], 4)
        self.assertEqual(signer.sent, [("@example_bot", "/start", None)])
        self.assertEqual(button.clicked, "每日签到")
        self.assertEqual(len(result.logs), 4)

    async def test_timeout_after_send_is_ambiguous_and_includes_step_logs(self):
        signer = FakeSigner([[]])
        values = BotFlowSkill().validate({
            "target": "@example_bot",
            "steps": [
                {"action": "send", "text": "/start", "timeout": 10},
                {"action": "wait_message", "match": "never", "timeout": 1},
            ],
        })
        with mock.patch("runner.skills.telegram_primitives.asyncio.sleep", new=mock.AsyncMock()):
            with self.assertRaises(SkillError) as raised:
                await BotFlowSkill()._execute_flow(signer, values)
        self.assertTrue(raised.exception.ambiguous)
        self.assertGreaterEqual(len(raised.exception.logs), 2)


if __name__ == "__main__":
    unittest.main()
