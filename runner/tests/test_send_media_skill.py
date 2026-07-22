import unittest
from types import SimpleNamespace

from runner.skills.base import SkillError, SkillValidationError
from runner.skills.send_media import SendMediaSkill


class FakeApp:
    def __init__(self):
        self.sent = None
        self.deleted = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        return False

    async def copy_message(self, target, source_chat, source_message, **kwargs):
        self.sent = (target, source_chat, source_message, kwargs)
        return SimpleNamespace(id=321, voice=SimpleNamespace(), caption="语音说明")

    async def delete_messages(self, target, message_id):
        self.deleted = (target, message_id)


class FakeSigner:
    def __init__(self):
        self.app = FakeApp()
        self.logged_in = False

    async def login(self, num_of_dialogs=1, print_chat=False):
        self.logged_in = num_of_dialogs == 1 and print_chat is False


class SendMediaSkillTests(unittest.TestCase):
    def test_accepts_a_direct_telegram_message_of_any_kind(self):
        skill = SendMediaSkill()
        values = skill.validate({
            "target": "@example_bot",
            "source_chat_id": "me",
            "source_message_id": 10,
            "caption": "",
        })
        self.assertEqual(values["source_chat_id"], "me")
        self.assertEqual(values["source_message_id"], 10)
        self.assertEqual(values["caption"], "")

    def test_direct_source_requires_both_chat_and_message_id(self):
        with self.assertRaises(SkillValidationError):
            SendMediaSkill().validate({
                "target": "@example_bot",
                "source_chat_id": "@source_chat",
            })

    def test_worker_media_lookup_failure_has_stable_error_code(self):
        with self.assertRaises(SkillError) as raised:
            SendMediaSkill().validate({
                "target": "@example_bot",
                "file_id": "media-asset-1234",
                "media_type": "photo",
                "_source_error": "media_asset_lookup_failed",
            })
        self.assertEqual(raised.exception.code, "media_asset_lookup_failed")
        self.assertTrue(raised.exception.retryable)
        self.assertFalse(raised.exception.ambiguous)

    def test_legacy_worker_asset_reference_remains_compatible(self):
        values = SendMediaSkill().validate({
            "target": "@example_bot",
            "file_id": "media-asset-1234",
            "media_type": "document",
            "_source_chat_id": "-1001234567890",
            "_source_message_id": 88,
            "caption": "Report",
        })
        self.assertEqual(values["source_message_id"], 88)
        self.assertEqual(values["media_type"], "document")


class SendMediaExecutionTests(unittest.IsolatedAsyncioTestCase):
    async def test_copies_any_telegram_message_and_saves_message_id(self):
        signer = FakeSigner()
        values = SendMediaSkill().validate({
            "target": "@example_bot",
            "source_chat_id": "-1001234567890",
            "source_message_id": 88,
            "caption": "Catalog",
            "message_thread_id": 7,
        })
        result = await SendMediaSkill()._send(signer, values)
        self.assertTrue(signer.logged_in)
        self.assertEqual(signer.app.sent, (
            "@example_bot",
            -1001234567890,
            88,
            {"caption": "Catalog", "message_thread_id": 7},
        ))
        self.assertEqual(result.data["message_id"], 321)
        self.assertEqual(result.data["content_type"], "voice")
        self.assertEqual(result.data["content_preview"], "语音说明")
        self.assertFalse(result.data["deleted"])


if __name__ == "__main__":
    unittest.main()
