from __future__ import annotations

import unittest
from datetime import datetime, timezone
from types import SimpleNamespace

from listener.manager import _match_source, _message_time


class ListenerReceiptContextTests(unittest.TestCase):
    def test_message_time_is_reported_in_utc(self):
        message = SimpleNamespace(date=datetime(2026, 7, 23, 1, 31, 26, tzinfo=timezone.utc))
        self.assertEqual(_message_time(message), "2026-07-23T01:31:26Z")
        self.assertEqual(_message_time(SimpleNamespace(date=None)), "")

    def test_match_source_explains_why_the_rule_fired(self):
        self.assertEqual(
            _match_source(keyword_hit=True, reply_hit=False, keyword="王者荣耀"),
            "消息文字",
        )
        self.assertEqual(
            _match_source(keyword_hit=True, reply_hit=True, keyword="报价"),
            "消息文字、回复关系",
        )
        self.assertEqual(
            _match_source(keyword_hit=False, reply_hit=False, keyword=""),
            "全部消息",
        )


if __name__ == "__main__":
    unittest.main()
