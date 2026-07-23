from __future__ import annotations

import unittest
from pathlib import Path
from types import SimpleNamespace

from listener.media_feedback import (
    MAX_FEEDBACK_MEDIA_BYTES,
    forward_message_media,
    media_preview,
    message_media_descriptor,
    original_message_text,
)


class FakeClient:
    async def download_media(self, _message, file_name: str):
        target = Path(file_name) / "downloaded.jpg"
        target.write_bytes(b"image-data")
        return str(target)


class FakeWorker:
    def __init__(self) -> None:
        self.call = None

    async def upload_event_media(self, path: Path, **kwargs):
        self.call = {"path": path, **kwargs}
        return {"sent": True, "reason": None}


class MediaFeedbackTests(unittest.IsolatedAsyncioTestCase):
    def test_photo_descriptor_uses_readable_metadata(self):
        message = SimpleNamespace(
            photo=SimpleNamespace(file_name=None, mime_type=None, file_size=1024),
            video=None,
            document=None,
            audio=None,
            voice=None,
            animation=None,
            sticker=None,
            video_note=None,
            caption="产品实拍图",
        )
        descriptor = message_media_descriptor(message)
        self.assertIsNotNone(descriptor)
        self.assertEqual(descriptor.kind, "photo")
        self.assertEqual(descriptor.label, "图片")
        self.assertEqual(descriptor.file_name, "telegram-photo.jpg")
        self.assertEqual(descriptor.mime_type, "image/jpeg")
        self.assertEqual(media_preview(message, descriptor), "产品实拍图")
        self.assertEqual(original_message_text(message), "产品实拍图")
        self.assertEqual(descriptor.event_fields()["media_label"], "图片")

    def test_document_descriptor_preserves_safe_file_name(self):
        message = SimpleNamespace(
            photo=None,
            video=None,
            document=SimpleNamespace(
                file_name="../采购清单.pdf",
                mime_type="application/pdf",
                file_size=2048,
            ),
            audio=None,
            voice=None,
            animation=None,
            sticker=None,
            video_note=None,
            caption=None,
            text=None,
        )
        descriptor = message_media_descriptor(message)
        self.assertEqual(descriptor.kind, "document")
        self.assertEqual(descriptor.file_name, "采购清单.pdf")
        self.assertEqual(media_preview(message, descriptor), "[文件] 采购清单.pdf")
        self.assertEqual(original_message_text(message), "")

    async def test_media_is_downloaded_temporarily_and_uploaded_with_context(self):
        message = SimpleNamespace(caption="现场视频", text=None)
        descriptor = SimpleNamespace(
            kind="photo",
            label="图片",
            file_name="scene.jpg",
            mime_type="image/jpeg",
            size_bytes=100,
        )
        worker = FakeWorker()
        result = await forward_message_media(
            FakeClient(),
            message,
            worker,
            descriptor=descriptor,
            event={"chat_label": "客户群", "sender_label": "采购经理（@buyer）"},
            receipt_message_id=88,
            account_name="外贸客服账号",
        )
        self.assertTrue(result["sent"])
        self.assertEqual(worker.call["receipt_message_id"], 88)
        self.assertEqual(worker.call["account_name"], "外贸客服账号")
        self.assertEqual(worker.call["chat_label"], "客户群")
        self.assertEqual(worker.call["sender_label"], "采购经理（@buyer）")
        self.assertEqual(worker.call["caption"], "现场视频")

    async def test_media_without_caption_uploads_an_empty_original_text(self):
        message = SimpleNamespace(caption=None, text=None)
        descriptor = SimpleNamespace(
            kind="photo",
            label="图片",
            file_name="scene.jpg",
            mime_type="image/jpeg",
            size_bytes=100,
        )
        worker = FakeWorker()
        result = await forward_message_media(
            FakeClient(),
            message,
            worker,
            descriptor=descriptor,
            event={"chat_label": "客户群", "sender_label": "采购经理"},
            receipt_message_id=88,
            account_name="客服账号",
        )
        self.assertTrue(result["sent"])
        self.assertEqual(worker.call["caption"], "")

    async def test_declared_oversized_media_is_not_downloaded(self):
        descriptor = SimpleNamespace(
            kind="video",
            label="视频",
            file_name="large.mp4",
            mime_type="video/mp4",
            size_bytes=MAX_FEEDBACK_MEDIA_BYTES + 1,
        )
        result = await forward_message_media(
            FakeClient(),
            SimpleNamespace(caption=None, text=None),
            FakeWorker(),
            descriptor=descriptor,
            event={},
            receipt_message_id=None,
            account_name="账号",
        )
        self.assertEqual(result, {"sent": False, "reason": "too_large"})


if __name__ == "__main__":
    unittest.main()
