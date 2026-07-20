from __future__ import annotations

import asyncio
import unittest
from types import SimpleNamespace

from listener.manager import (
    REPLIES_PER_RULE_PER_HOUR,
    RealtimeManager,
)


class FakeWorker:
    def __init__(self) -> None:
        self.events = []

    async def record_event(self, payload):
        self.events.append(payload)


class FakeMessage:
    def __init__(self, message_id: int, *, sender_id: int = 10, is_bot: bool = False) -> None:
        self.id = message_id
        self.outgoing = False
        self.chat = SimpleNamespace(id=-100123, username="example", type="supergroup")
        self.from_user = SimpleNamespace(id=sender_id, is_bot=is_bot)
        self.text = "客服价格"
        self.caption = None
        self.reply_markup = None
        self.replies = []

    async def reply_text(self, value):
        self.replies.append(value)


class ReplyLimiterTests(unittest.TestCase):
    def test_same_rule_chat_and_sender_has_sixty_second_cooldown(self):
        clock = [100.0]
        manager = RealtimeManager(FakeWorker(), monotonic=lambda: clock[0])
        self.assertTrue(manager._allow_reply("rule", "chat", "sender"))
        self.assertFalse(manager._allow_reply("rule", "chat", "sender"))
        clock[0] += 59
        self.assertFalse(manager._allow_reply("rule", "chat", "sender"))
        clock[0] += 1
        self.assertTrue(manager._allow_reply("rule", "chat", "sender"))

    def test_each_rule_is_limited_to_sixty_replies_per_hour(self):
        manager = RealtimeManager(FakeWorker(), monotonic=lambda: 100.0)
        for index in range(REPLIES_PER_RULE_PER_HOUR):
            self.assertTrue(manager._allow_reply("rule", "chat", f"sender-{index}"))
        self.assertFalse(manager._allow_reply("rule", "chat", "sender-over-limit"))


class ReplySafetyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.worker = FakeWorker()
        self.manager = RealtimeManager(self.worker, monotonic=lambda: 100.0)
        self.manager.rules_by_account = {
            "account": [{
                "id": "rule",
                "name": "客服回复",
                "kind": "keyword_reply",
                "chat_selector": "*",
                "keyword": "价格",
                "response_text": "请联系人工客服。",
                "enabled": True,
                "case_sensitive": False,
            }],
        }

    async def test_bot_messages_never_trigger_automatic_replies(self):
        message = FakeMessage(1, is_bot=True)
        await self.manager._handle_message("account", None, message)
        await asyncio.sleep(0)
        self.assertEqual(message.replies, [])
        self.assertEqual(self.worker.events, [])

    async def test_human_message_replies_once_and_cooldown_blocks_repeat(self):
        first = FakeMessage(1)
        second = FakeMessage(2)
        await self.manager._handle_message("account", None, first)
        await asyncio.sleep(0)
        await self.manager._handle_message("account", None, second)
        await asyncio.sleep(0)
        self.assertEqual(first.replies, ["请联系人工客服。"])
        self.assertEqual(second.replies, [])
        self.assertEqual(len(self.worker.events), 1)
        self.assertEqual(self.worker.events[0]["event_kind"], "keyword_replied")


if __name__ == "__main__":
    unittest.main()
