from __future__ import annotations

import asyncio
import re
from collections.abc import Mapping
from typing import Any

from runner.skills.base import (
    Skill,
    SkillContext,
    SkillError,
    SkillResult,
    SkillValidationError,
    optional_int,
    required_text,
)
from runner.skills.telegram_adapter import (
    build_signer,
    classify_telegram_exception,
    telegram_environment,
)
from runner.skills.telegram_primitives import message_id, normalize_target
from runner.skills.telegram_primitives import message_text
from runner.workspace import SecretWorkspace

_MEDIA_TYPES = frozenset({"photo", "document", "video"})
_FILE_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$")


class SendMediaSkill(Skill):
    name = "send_media"

    def validate(self, params: Mapping[str, Any]) -> dict[str, Any]:
        source_error = str(params.get("_source_error") or "").strip()
        if source_error:
            raise SkillError(
                "The Worker-approved Telegram media source is unavailable",
                code=source_error,
                retryable=source_error == "media_asset_lookup_failed",
                ambiguous=False,
            )
        direct_chat = params.get("source_chat_id")
        direct_message = params.get("source_message_id")
        direct_source = direct_chat not in (None, "") or direct_message not in (None, "")
        file_id: str | None = None
        media_type: str | None = None
        if direct_source:
            source_chat = direct_chat
            source_message = optional_int(
                direct_message, "source_message_id", minimum=1
            )
        else:
            file_id = required_text(params.get("file_id"), "file_id", maximum=160)
            if not _FILE_ID_PATTERN.fullmatch(file_id):
                raise SkillValidationError("file_id must be a Worker-issued media asset id")
            media_type = required_text(params.get("media_type"), "media_type", maximum=20)
            if media_type not in _MEDIA_TYPES:
                raise SkillValidationError("media_type must be photo, document, or video")
            source_chat = params.get("_source_chat_id")
            source_message = optional_int(
                params.get("_source_message_id"), "_source_message_id", minimum=1
            )
        if source_chat in (None, "") or source_message is None:
            raise SkillValidationError("Telegram source chat and message id are required")
        caption_value = params.get("caption")
        caption = None if caption_value is None else str(caption_value)
        if caption is not None and len(caption) > 1024:
            raise SkillValidationError("caption must not exceed 1024 characters")
        return {
            "target": normalize_target(params.get("target")),
            "file_id": file_id,
            "media_type": media_type,
            "source_chat_id": normalize_target(source_chat),
            "source_message_id": source_message,
            "caption": caption,
            "message_thread_id": optional_int(
                params.get("message_thread_id"), "message_thread_id", minimum=1
            ),
            "delete_after": optional_int(
                params.get("delete_after"), "delete_after", minimum=0, maximum=86400
            ),
        }

    async def _send(self, signer: Any, values: dict[str, Any]) -> SkillResult:
        await signer.login(num_of_dialogs=1, print_chat=False)
        async with signer.app:
            send_kwargs: dict[str, Any] = {"caption": values["caption"]}
            if values["message_thread_id"] is not None:
                send_kwargs["message_thread_id"] = values["message_thread_id"]
            copied = await signer.app.copy_message(
                values["target"],
                values["source_chat_id"],
                values["source_message_id"],
                **send_kwargs,
            )
            copied_id = message_id(copied)
            if copied_id <= 0:
                raise SkillError(
                    "Telegram did not return a message id for the copied message",
                    code="content_message_id_missing",
                    retryable=False,
                    ambiguous=True,
                )
            content_type = "message"
            for candidate in (
                "text", "photo", "video", "document", "audio", "voice",
                "animation", "sticker", "video_note", "poll", "contact",
                "location", "venue", "game", "invoice", "story",
            ):
                if getattr(copied, candidate, None) is not None:
                    content_type = candidate
                    break
            preview = message_text(copied).strip()[:500]
            deleted = False
            if values["delete_after"] is not None:
                if values["delete_after"]:
                    await asyncio.sleep(values["delete_after"])
                await signer.app.delete_messages(values["target"], copied_id)
                deleted = True
            data = {
                    "delivered": True,
                    "source_chat_id": values["source_chat_id"],
                    "source_message_id": values["source_message_id"],
                    "content_type": content_type,
                    "content_preview": preview,
                    "message_id": copied_id,
                    "deleted": deleted,
                }
            if values["file_id"] is not None:
                data["legacy_asset_id"] = values["file_id"]
            return SkillResult(
                data=data,
                logs=[{
                    "level": "info",
                    "event": "telegram_content_copied",
                    "content_type": content_type,
                    "message_id": copied_id,
                    "deleted": deleted,
                }],
            )

    def execute(self, context: SkillContext, params: Mapping[str, Any]) -> SkillResult:
        values = self.validate(params)
        try:
            with SecretWorkspace(prefix="telegram-media-") as workspace:
                with telegram_environment(context.secrets):
                    signer = build_signer(context, task_name=None, workspace=workspace)
                    return signer.loop.run_until_complete(self._send(signer, values))
        except Exception as exc:
            if isinstance(exc, (SkillError, SkillValidationError)):
                raise
            raise classify_telegram_exception(exc) from exc


__test__ = {"media_types": _MEDIA_TYPES}
