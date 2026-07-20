from __future__ import annotations

import pathlib
import unittest
from types import SimpleNamespace

from listener.reply_limits import (
    REPLIES_PER_RULE_PER_HOUR,
    ReplyLimiter,
    is_human_sender,
)


class ReplyLimiterTests(unittest.TestCase):
    def test_same_rule_chat_and_sender_has_sixty_second_cooldown(self):
        clock = [100.0]
        limiter = ReplyLimiter(monotonic=lambda: clock[0])
        self.assertTrue(limiter.allow("rule", "chat", "sender"))
        self.assertFalse(limiter.allow("rule", "chat", "sender"))
        clock[0] += 59
        self.assertFalse(limiter.allow("rule", "chat", "sender"))
        clock[0] += 1
        self.assertTrue(limiter.allow("rule", "chat", "sender"))

    def test_each_rule_is_limited_to_sixty_replies_per_hour(self):
        limiter = ReplyLimiter(monotonic=lambda: 100.0)
        for index in range(REPLIES_PER_RULE_PER_HOUR):
            self.assertTrue(limiter.allow("rule", "chat", f"sender-{index}"))
        self.assertFalse(limiter.allow("rule", "chat", "sender-over-limit"))

    def test_bot_and_anonymous_senders_cannot_trigger_auto_reply(self):
        self.assertFalse(is_human_sender(None))
        self.assertFalse(is_human_sender(SimpleNamespace(is_bot=True)))
        self.assertTrue(is_human_sender(SimpleNamespace(is_bot=False)))

    def test_manager_applies_human_sender_and_reply_limiter_guards(self):
        source = pathlib.Path("listener/manager.py").read_text(encoding="utf-8")
        self.assertIn("if not is_human_sender(sender)", source)
        self.assertIn("self._reply_limiter.allow", source)
        self.assertIn("if getattr(message, \"outgoing\", False)", source)


if __name__ == "__main__":
    unittest.main()
