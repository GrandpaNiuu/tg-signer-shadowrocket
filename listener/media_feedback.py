from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from listener.worker_client import ListenerWorkerClient

LOGGER = logging.getLogger("telegram-listener.media-feedback")
MAX_FEEDBACK_MEDIA_BYTES = 20 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class MediaDescriptor:
    kind: str
    label: str
    file_name: str
    mime_type: str
    size_bytes: int

    def event_fields(self) -> dict[str, Any]:
        return {
            "media_kind": self.kind,
            "media_label": self.label,
            "media_file_name": self.file_name,
            "media_mime_type": self.mime_type,
            "media_size_bytes": self.size_bytes,
        }


_MEDIA_FIELDS = (
    ("photo", "图片", "telegram-photo.jpg", "image/jpeg"),
    ("video", "视频", "telegram-video.mp4", "video/mp4"),
    ("document", "文件", "telegram-document.bin", "application/octet-stream"),
    ("audio", "音频", "telegram-audio.mp3", "audio/mpeg"),
    ("voice", "语音", "telegram-voice.ogg", "audio/ogg"),
    ("animation", "动图", "telegram-animation.gif", "image/gif"),
    ("sticker", "贴纸", "telegram-sticker.webp", "image/webp"),
    ("video_note", "视频消息", "telegram-video-note.mp4", "video/mp4"),
)


def _safe_file_name(value: Any, fallback: str) -> str:
    leaf = str(value or "").replace("\\", "/").split("/")[-1].strip()
    clean = "".join(character for character in leaf if ord(character) >= 32 and ord(character) != 127)
    return clean[:160] or fallback


def _safe_size(value: Any) -> int:
    try:
        size = int(value or 0)
    except (TypeError, ValueError):
        return 0
    return size if size >= 0 else 0


def message_media_descriptor(message: Any) -> MediaDescriptor | None:
    for field, label, fallback_name, fallback_mime in _MEDIA_FIELDS:
        media = getattr(message, field, None)
        if media is None:
            continue
        return MediaDescriptor(
            kind=field,
            label=label,
            file_name=_safe_file_name(getattr(media, "file_name", None), fallback_name),
            mime_type=str(getattr(media, "mime_type", None) or fallback_mime).strip()[:120],
            size_bytes=_safe_size(getattr(media, "file_size", None)),
        )
    return None


def media_preview(message: Any, descriptor: MediaDescriptor) -> str:
    caption = str(getattr(message, "caption", None) or getattr(message, "text", None) or "").strip()
    if caption:
        return caption[:600]
    return f"[{descriptor.label}] {descriptor.file_name}"[:600]


async def forward_message_media(
    client: Any,
    message: Any,
    worker: "ListenerWorkerClient",
    *,
    descriptor: MediaDescriptor,
    event: dict[str, Any],
    receipt_message_id: int | None,
    account_name: str,
) -> dict[str, Any]:
    if descriptor.size_bytes > MAX_FEEDBACK_MEDIA_BYTES:
        return {"sent": False, "reason": "too_large"}

    with TemporaryDirectory(prefix="telegram-listener-feedback-") as directory:
        try:
            downloaded = await client.download_media(message, file_name=f"{directory}/")
        except Exception as exc:
            LOGGER.warning("Telegram media download failed: %s", type(exc).__name__)
            return {"sent": False, "reason": "download_failed"}
        if not downloaded:
            return {"sent": False, "reason": "download_missing"}

        path = Path(str(downloaded))
        try:
            actual_size = path.stat().st_size
        except OSError:
            return {"sent": False, "reason": "download_missing"}
        if actual_size < 1:
            return {"sent": False, "reason": "empty_file"}
        if actual_size > MAX_FEEDBACK_MEDIA_BYTES:
            return {"sent": False, "reason": "too_large"}

        try:
            return await worker.upload_event_media(
                path,
                media_kind=descriptor.kind,
                media_file_name=descriptor.file_name or path.name,
                media_mime_type=descriptor.mime_type,
                receipt_message_id=receipt_message_id,
                account_name=account_name,
                chat_label=str(event.get("chat_label") or "会话名称未公开"),
                sender_label=str(event.get("sender_label") or "发送者身份未公开"),
                caption=media_preview(message, descriptor),
            )
        except Exception as exc:
            LOGGER.warning("Listener media feedback upload failed: %s", type(exc).__name__)
            return {"sent": False, "reason": "upload_failed"}


__all__ = [
    "MAX_FEEDBACK_MEDIA_BYTES",
    "MediaDescriptor",
    "forward_message_media",
    "media_preview",
    "message_media_descriptor",
]
