from __future__ import annotations

import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from listener.media_upload import _safe_file_name, send_uploaded_file, stage_media_upload


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


class FakeWorker:
    def __init__(self, *, callback_failures: int = 0) -> None:
        self.callback_failures = callback_failures
        self.completions: list[dict] = []
        self.downloaded_name = ""

    async def download_media_upload(self, upload_id, target: Path, *, expected_size: int):
        self.downloaded_name = target.name
        target.write_bytes(b"x" * expected_size)

    async def complete_media_upload(self, upload_id, **payload):
        if self.callback_failures:
            self.callback_failures -= 1
            raise ConnectionError("temporary callback failure")
        self.completions.append(payload)


class FailingClient(FakeClient):
    async def send_document(self, chat, path, **kwargs):
        self.calls.append(("document", chat, path, kwargs))
        raise ConnectionError("socket closed after send")


class MediaUploadTests(unittest.IsolatedAsyncioTestCase):
    def test_original_file_name_is_preserved_without_path_traversal(self):
        self.assertEqual(_safe_file_name("../季度 报告.pdf"), "季度 报告.pdf")
        self.assertEqual(_safe_file_name("..\\voice note.ogg"), "voice note.ogg")

    async def test_every_supported_kind_is_staged_in_saved_messages(self):
        for kind in ("photo", "video", "audio", "voice", "animation", "video_note", "sticker", "document"):
            with self.subTest(kind=kind):
                client = FakeClient()
                message_id = await send_uploaded_file(client, "/tmp/content.bin", kind)
                self.assertEqual(message_id, 321)
                self.assertEqual(client.calls[0][0], kind)
                self.assertEqual(client.calls[0][1], "me")
                self.assertTrue(client.calls[0][3]["disable_notification"])

    async def test_success_callback_retries_without_sending_the_file_twice(self):
        worker = FakeWorker(callback_failures=1)
        client = FakeClient()
        job = {
            "upload": {
                "id": "upload-1",
                "file_name": "原始文件.pdf",
                "size_bytes": 1,
                "content_kind": "document",
            },
            "account": {"id": "account-1"},
        }
        with patch("listener.media_upload.asyncio.sleep", new=AsyncMock()):
            message_id = await stage_media_upload(job, worker, existing_client=client)
        self.assertEqual(message_id, 321)
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(worker.downloaded_name, "原始文件.pdf")
        self.assertEqual(worker.completions, [{"status": "ready", "source_message_id": 321}])

    async def test_transport_failure_is_reported_as_ambiguous_and_not_retried(self):
        worker = FakeWorker()
        client = FailingClient()
        job = {
            "upload": {
                "id": "upload-2",
                "file_name": "message.bin",
                "size_bytes": 1,
                "content_kind": "document",
            },
            "account": {"id": "account-1"},
        }
        with self.assertRaises(ConnectionError):
            await stage_media_upload(job, worker, existing_client=client)
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(worker.completions[0]["status"], "ambiguous")
        self.assertEqual(worker.completions[0]["error_code"], "telegram_transport")


if __name__ == "__main__":
    unittest.main()
