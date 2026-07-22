from __future__ import annotations

import unittest

from listener.media_upload import send_uploaded_file


class FakeMessage:
    id = 321


class FakeClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str, dict]] = []

    async def _record(self, method: str, chat: str, path: str, **kwargs):
        self.calls.append((method, chat, path, kwargs))
        return FakeMessage()

    async def send_photo(self, chat, path, **kwargs):
        return await self._record("photo", chat, path, **kwargs)

    async def send_video(self, chat, path, **kwargs):
        return await self._record("video", chat, path, **kwargs)

    async def send_audio(self, chat, path, **kwargs):
        return await self._record("audio", chat, path, **kwargs)

    async def send_voice(self, chat, path, **kwargs):
        return await self._record("voice", chat, path, **kwargs)

    async def send_animation(self, chat, path, **kwargs):
        return await self._record("animation", chat, path, **kwargs)

    async def send_video_note(self, chat, path, **kwargs):
        return await self._record("video_note", chat, path, **kwargs)

    async def send_sticker(self, chat, path, **kwargs):
        return await self._record("sticker", chat, path, **kwargs)

    async def send_document(self, chat, path, **kwargs):
        return await self._record("document", chat, path, **kwargs)


class MediaUploadTests(unittest.IsolatedAsyncioTestCase):
    async def test_every_supported_kind_is_staged_in_saved_messages(self):
        for kind in ("photo", "video", "audio", "voice", "animation", "video_note", "sticker", "document"):
            with self.subTest(kind=kind):
                client = FakeClient()
                message_id = await send_uploaded_file(client, "/tmp/content.bin", kind)
                self.assertEqual(message_id, 321)
                self.assertEqual(client.calls[0][0], kind)
                self.assertEqual(client.calls[0][1], "me")
                self.assertTrue(client.calls[0][3]["disable_notification"])


if __name__ == "__main__":
    unittest.main()
