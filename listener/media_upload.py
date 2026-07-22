from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path
from typing import Any

from runner.skills.telegram_adapter import classify_telegram_exception

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


def _safe_file_name(file_name: str) -> str:
    leaf = str(file_name or "").replace("\\", "/").split("/")[-1]
    clean = "".join(character for character in leaf if ord(character) >= 32 and ord(character) != 127).strip()
    if clean in {"", ".", ".."}:
        return "telegram-content.bin"
    return clean[:160]


async def _complete_with_retry(worker, upload_id: str, **payload: Any) -> None:
    last_error: Exception | None = None
    for delay in (0, 1, 2, 4, 8):
        if delay:
            await asyncio.sleep(delay)
        try:
            await worker.complete_media_upload(upload_id, **payload)
            return
        except Exception as exc:  # Worker acknowledgement is safe and idempotent to retry.
            last_error = exc
    if last_error is not None:
        raise last_error


async def stage_media_upload(
    job: dict[str, Any],
    worker,
    *,
    existing_client=None,
) -> int:
    upload = dict(job.get("upload") or {})
    account = dict(job.get("account") or {})
    upload_id = str(upload.get("id") or "")
    if not upload_id or not account.get("id"):
        raise RuntimeError("Media upload claim is incomplete")

    temporary_client = existing_client is None
    if temporary_client:
        from listener.telegram_runtime import build_client, stop_client

        client = build_client(account, suffix="_media_upload")
        await client.start()
    else:
        client = existing_client
    try:
        try:
            with tempfile.TemporaryDirectory(prefix="telegram-media-stage-") as directory:
                target = Path(directory) / _safe_file_name(str(upload.get("file_name") or ""))
                await worker.download_media_upload(
                    upload_id,
                    target,
                    expected_size=int(upload.get("size_bytes") or 0),
                )
                message_id = await send_uploaded_file(
                    client,
                    str(target),
                    str(upload.get("content_kind") or "document"),
                )
        except Exception as exc:
            classified = classify_telegram_exception(exc)
            status = "ambiguous" if classified.ambiguous else "failed"
            await _complete_with_retry(
                worker,
                upload_id,
                status=status,
                error_code=classified.code,
                error_message=(
                    "Telegram 返回结果不确定；为避免重复发送，请检查账号收藏夹后重试。"
                    if classified.ambiguous
                    else f"内容未能保存到 Telegram：{type(exc).__name__}"
                ),
            )
            raise
        await _complete_with_retry(
            worker,
            upload_id,
            status="ready",
            source_message_id=message_id,
        )
        return message_id
    finally:
        if temporary_client:
            await stop_client(client)
