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

    async def get_messages(self, chat_id, message_id):
        self.source = (chat_id, message_id)
        return SimpleNamespace(photo=SimpleNamespace(file_id="telegram-cached-file"))

    async def send_photo(self, target, file_id, **kwargs):
        self.sent = (target, file_id, kwargs)
        return SimpleNamespace(id=321)

    async def delete_messages(self, target, message_id):
        self.deleted = (target, message_id)


class FakeSigner:
    def __init__(self):
        self.app = FakeApp()
        self.logged_in = False

    async def login(self, num_of_dialogs=1, print_chat=False):
        self.logged_in = num_of_dialogs == 1 and print_chat is False


class SendMediaSkillTests(unittest.TestCase):
    def test_requires_worker_resolved_source_and_rejects_paths(self):
        skill = SendMediaSkill()
        with self.assertRaises(SkillValidationError):
            skill.validate({
                "target": "@example_bot",
                "file_id": "/tmp/photo.jpg",
                "media_type": "photo",
                "_source_chat_id": "@source_chat",
                "_source_message_id": 10,
            })
        with self.assertRaises(SkillValidationError):
            skill.validate({"target": "@example_bot", "file_id": "asset-1234", "media_type": "photo"})

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

    def test_validates_approved_asset_reference(self):
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
    async def test_uses_telegram_cached_file_and_saves_message_id(self):
        signer = FakeSigner()
        values = SendMediaSkill().validate({
            "target": "@example_bot",
            "file_id": "media-asset-1234",
            "media_type": "photo",
            "_source_chat_id": "-1001234567890",
            "_source_message_id": 88,
            "caption": "Catalog",
            "message_thread_id": 7,
        })
        result = await SendMediaSkill()._send(signer, values)
        self.assertTrue(signer.logged_in)
        self.assertEqual(signer.app.source, (-1001234567890, 88))
        self.assertEqual(signer.app.sent, (
            "@example_bot",
            "telegram-cached-file",
            {"caption": "Catalog", "message_thread_id": 7},
        ))
        self.assertEqual(result.data["message_id"], 321)
        self.assertFalse(result.data["deleted"])


if __name__ == "__main__":
    unittest.main()
