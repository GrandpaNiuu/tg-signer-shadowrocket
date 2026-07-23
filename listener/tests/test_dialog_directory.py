from __future__ import annotations

import unittest
from datetime import datetime, timezone
from types import SimpleNamespace

from listener.dialog_directory import MAX_DIALOGS, collect_dialogs, dialog_record


class FakeClient:
    def __init__(self, dialogs):
        self.dialogs = dialogs
        self.limit = None

    async def get_dialogs(self, limit):
        self.limit = limit
        for dialog in self.dialogs:
            yield dialog


class DialogDirectoryTests(unittest.IsolatedAsyncioTestCase):
    def test_private_friend_uses_name_and_username_instead_of_visible_numeric_id(self):
        dialog = SimpleNamespace(
            chat=SimpleNamespace(
                id=998877,
                type="ChatType.PRIVATE",
                first_name="张",
                last_name="三",
                username="zhangsan",
                is_bot=False,
            ),
            top_message=SimpleNamespace(date=datetime(2026, 7, 23, tzinfo=timezone.utc)),
        )
        record = dialog_record(dialog)
        self.assertEqual(record["target"], "@zhangsan")
        self.assertEqual(record["peer_type"], "private")
        self.assertEqual(record["title"], "张 三")
        self.assertEqual(record["label"], "张 三（@zhangsan） · 好友")
        self.assertNotIn("998877", record["label"])
        self.assertTrue(record["is_writable"])
        self.assertEqual(record["last_message_at"], "2026-07-23T00:00:00+00:00")

    def test_bot_and_group_are_classified_for_picker_groups(self):
        bot = dialog_record(SimpleNamespace(
            chat=SimpleNamespace(
                id=1234,
                type="ChatType.PRIVATE",
                first_name="订单助手",
                last_name=None,
                username="order_helper_bot",
                is_bot=True,
            ),
            top_message=None,
        ))
        group = dialog_record(SimpleNamespace(
            chat=SimpleNamespace(
                id=-1005566,
                type="ChatType.SUPERGROUP",
                title="客户售后群",
                username="support_group",
            ),
            top_message=None,
        ))
        self.assertEqual(bot["peer_type"], "bot")
        self.assertEqual(bot["label"], "订单助手（@order_helper_bot） · 机器人")
        self.assertEqual(group["peer_type"], "supergroup")
        self.assertEqual(group["target"], "@support_group")
        self.assertEqual(group["label"], "客户售后群（@support_group） · 超级群组")

    def test_private_target_without_username_keeps_numeric_target_but_readable_label(self):
        record = dialog_record(SimpleNamespace(
            chat=SimpleNamespace(
                id=776655,
                type="private",
                first_name="采购经理",
                last_name=None,
                username=None,
                is_bot=False,
            ),
            top_message=None,
        ))
        self.assertEqual(record["target"], "776655")
        self.assertEqual(record["label"], "采购经理 · 好友")
        self.assertNotIn("776655", record["label"])

    def test_channel_write_permission_is_explicit(self):
        read_only = dialog_record(SimpleNamespace(
            chat=SimpleNamespace(
                id=-10099,
                type="channel",
                title="行业资讯频道",
                username="industry_news",
                privileges=None,
            ),
            top_message=None,
        ))
        writable = dialog_record(SimpleNamespace(
            chat=SimpleNamespace(
                id=-100100,
                type="channel",
                title="企业公告频道",
                username="company_news",
                privileges=SimpleNamespace(can_post_messages=True),
            ),
            top_message=None,
        ))
        self.assertFalse(read_only["is_writable"])
        self.assertTrue(writable["is_writable"])

    async def test_collect_dialogs_uses_the_bounded_directory_limit(self):
        dialogs = [SimpleNamespace(
            chat=SimpleNamespace(id=1, type="private", first_name="A", last_name=None, username="user_a"),
            top_message=None,
        )]
        client = FakeClient(dialogs)
        records = await collect_dialogs(client)
        self.assertEqual(client.limit, MAX_DIALOGS)
        self.assertEqual(len(records), 1)


if __name__ == "__main__":
    unittest.main()
