from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any

_SEND_METHODS = {
    "photo": "send_photo",
    "video": "send_video",
    "audio": "send_audio",
    "voice": "send_voice",
    "animation": "send_animation",
    "video_note": "send_video_note",
    "sticker": "send_sticker",
    "document": "send_document",
}


async def send_uploaded_file(client, path: str, content_kind: str) -> int:
    method_name = _SEND_METHODS.get(str(content_kind), "send_document")
    method = getattr(client, method_name)
    message = await method("me", path, disable_notification=True)
    message_id = int(getattr(message, "id", 0) or 0)
    if message_id < 1:
        raise RuntimeError("Telegram did not return a message id")
    return message_id


def _safe_suffix(file_name: str) -> str:
    suffix = Path(str(file_name)).suffix.lower()
    if len(suffix) > 16 or any(not (character.isalnum() or character == ".") for character in suffix):
        return ".bin"
    return suffix or ".bin"


async def stage_media_upload(
    job: dict[str, Any],
    worker,
    *,
    existing_client=None,
) -> int:
    from listener.telegram_runtime import build_client, stop_client

    upload = dict(job.get("upload") or {})
    account = dict(job.get("account") or {})
    upload_id = str(upload.get("id") or "")
    if not upload_id or not account.get("id"):
        raise RuntimeError("Media upload claim is incomplete")

    client = existing_client or build_client(account, suffix="_media_upload")
    temporary_client = existing_client is None
    if temporary_client:
        await client.start()
    try:
        with tempfile.TemporaryDirectory(prefix="telegram-media-stage-") as directory:
            target = Path(directory) / f"content{_safe_suffix(str(upload.get('file_name') or ''))}"
            await worker.download_media_upload(
                upload_id,
                target,
                expected_size=int(upload.get("size_bytes") or 0),
            )
            message_id = await send_uploaded_file(client, str(target), str(upload.get("content_kind") or "document"))
        await worker.complete_media_upload(
            upload_id,
            status="ready",
            source_message_id=message_id,
        )
        return message_id
    except Exception as exc:
        try:
            await worker.complete_media_upload(
                upload_id,
                status="failed",
                error_code="telegram_stage_failed",
                error_message=f"内容未能保存到 Telegram：{type(exc).__name__}",
            )
        except Exception:
            pass
        raise
    finally:
        if temporary_client:
            await stop_client(client)
