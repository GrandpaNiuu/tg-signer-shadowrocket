from __future__ import annotations

import unittest
from types import SimpleNamespace

from listener.event_identity import chat_identity, message_source, sender_identity


class EventIdentityTests(unittest.TestCase):
    def test_public_supergroup_and_user_are_human_readable(self):
        message = SimpleNamespace(
            chat=SimpleNamespace(
                id=-1001234567890,
                type="supergroup",
                title="客户售后群",
                username="support_group",
                first_name=None,
                last_name=None,
            ),
            from_user=SimpleNamespace(
                id=987654321,
                first_name="张",
                last_name="三",
                username="zhangsan",
                is_bot=False,
            ),
            sender_chat=None,
            author_signature=None,
            link="https://t.me/support_group/88",
        )

        source = message_source(message)

        self.assertEqual(source["chat_label"], "客户售后群（@support_group）")
        self.assertEqual(source["chat_type"], "supergroup")
        self.assertEqual(source["sender_label"], "张 三（@zhangsan）")
        self.assertEqual(source["sender_type"], "user")
        self.assertEqual(source["message_link"], "https://t.me/support_group/88")

    def test_private_chat_uses_person_name_and_username(self):
        value = chat_identity(SimpleNamespace(
            id=123,
            type=SimpleNamespace(value="private"),
            title=None,
            first_name="Alice",
            last_name="Chen",
            username="alice",
        ))
        self.assertEqual(value["chat_label"], "Alice Chen（@alice）")
        self.assertEqual(value["chat_type"], "private")

    def test_anonymous_admin_is_not_misreported_as_a_person(self):
        message = SimpleNamespace(
            from_user=None,
            sender_chat=SimpleNamespace(
                id=-1009,
                type="supergroup",
                title="运营群",
                username="",
                first_name=None,
                last_name=None,
            ),
            author_signature=None,
        )
        value = sender_identity(message)
        self.assertEqual(value["sender_type"], "anonymous_admin")
        self.assertEqual(value["sender_label"], "匿名管理员：运营群")

    def test_missing_public_identity_uses_explanation_not_bare_id(self):
        chat = chat_identity(SimpleNamespace(
            id=-1001,
            type="channel",
            title=None,
            username=None,
            first_name=None,
            last_name=None,
        ))
        self.assertEqual(chat["chat_label"], "频道（名称未公开）")

        sender = sender_identity(SimpleNamespace(from_user=None, sender_chat=None, author_signature=None))
        self.assertEqual(sender["sender_label"], "发送者身份未公开")

    def test_untrusted_message_link_is_discarded(self):
        message = SimpleNamespace(
            chat=SimpleNamespace(id=1, type="private", first_name="A", last_name=None, title=None, username=None),
            from_user=SimpleNamespace(id=2, first_name="B", last_name=None, username=None, is_bot=False),
            sender_chat=None,
            author_signature=None,
            link="https://example.com/not-telegram",
        )
        self.assertEqual(message_source(message)["message_link"], "")


if __name__ == "__main__":
    unittest.main()
