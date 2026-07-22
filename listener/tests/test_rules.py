from __future__ import annotations

import unittest
from types import SimpleNamespace

from listener.rules import (
    GROUP_TYPES,
    REPLY_TRIGGER_MODES,
    chat_type_name,
    keyword_matches,
    message_buttons,
    message_text,
    parse_proxy,
    replies_to_own_message,
    selector_matches,
    suggested_button,
    trigger_matches,
)


class ListenerRuleTests(unittest.TestCase):
    def test_proxy_is_parsed_without_logging_credentials(self):
        value = parse_proxy("socks5://user:pass@example.com:1080")
        self.assertEqual(value["scheme"], "socks5")
        self.assertEqual(value["hostname"], "example.com")
        self.assertEqual(value["port"], 1080)
        self.assertEqual(value["username"], "user")
        self.assertEqual(value["password"], "pass")
        self.assertIsNone(parse_proxy("not-a-proxy"))

    def test_selector_matches_wildcard_username_and_numeric_chat(self):
        chat = SimpleNamespace(id=-100123, username="ExampleGroup", type="supergroup")
        message = SimpleNamespace(chat=chat)
        self.assertTrue(selector_matches("*", message))
        self.assertTrue(selector_matches("@examplegroup", message))
        self.assertTrue(selector_matches("-100123", message))
        self.assertFalse(selector_matches("@other", message))
        self.assertEqual(chat_type_name(chat), "supergroup")
        self.assertIn(chat_type_name(chat), GROUP_TYPES)

    def test_keyword_matching_can_be_case_sensitive(self):
        self.assertTrue(keyword_matches("Price", "current price", case_sensitive=False))
        self.assertFalse(keyword_matches("Price", "current price", case_sensitive=True))
        self.assertTrue(keyword_matches("", "anything", case_sensitive=True))

    def test_message_content_and_buttons_are_extracted_safely(self):
        buttons = [[SimpleNamespace(text="每日签到"), SimpleNamespace(text="积分")]]
        message = SimpleNamespace(
            text=None,
            caption="图片说明",
            reply_markup=SimpleNamespace(inline_keyboard=buttons),
        )
        self.assertEqual(message_text(message), "图片说明")
        self.assertEqual(message_buttons(message), ["每日签到", "积分"])
        self.assertEqual(suggested_button(["积分", "每日签到"]), "每日签到")
        self.assertIsNone(suggested_button([]))

    def test_reply_trigger_recognizes_messages_sent_by_the_authorized_account(self):
        own_message = SimpleNamespace(outgoing=True, from_user=None)
        self_message = SimpleNamespace(outgoing=False, from_user=SimpleNamespace(is_self=True))
        other_message = SimpleNamespace(outgoing=False, from_user=SimpleNamespace(is_self=False))
        self.assertTrue(replies_to_own_message(SimpleNamespace(reply_to_message=own_message)))
        self.assertTrue(replies_to_own_message(SimpleNamespace(reply_to_message=self_message)))
        self.assertFalse(replies_to_own_message(SimpleNamespace(reply_to_message=other_message)))
        self.assertFalse(replies_to_own_message(SimpleNamespace(reply_to_message=None)))

    def test_reply_trigger_modes_preserve_keyword_rules_and_support_replies(self):
        self.assertEqual(REPLY_TRIGGER_MODES, {"keyword", "reply_to_own", "keyword_or_reply_to_own"})
        self.assertTrue(trigger_matches("keyword", keyword_match=True, reply_to_own=False))
        self.assertFalse(trigger_matches("keyword", keyword_match=False, reply_to_own=True))
        self.assertTrue(trigger_matches("reply_to_own", keyword_match=False, reply_to_own=True))
        self.assertFalse(trigger_matches("reply_to_own", keyword_match=True, reply_to_own=False))
        self.assertTrue(trigger_matches("keyword_or_reply_to_own", keyword_match=True, reply_to_own=False))
        self.assertTrue(trigger_matches("keyword_or_reply_to_own", keyword_match=False, reply_to_own=True))


if __name__ == "__main__":
    unittest.main()
