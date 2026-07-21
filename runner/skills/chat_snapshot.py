from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from runner.skills.base import (
    Skill,
    SkillContext,
    SkillError,
    SkillResult,
    SkillValidationError,
    optional_int,
)
from runner.skills.telegram_adapter import (
    build_signer,
    classify_telegram_exception,
    telegram_environment,
)
from runner.skills.telegram_primitives import (
    message_id,
    message_text,
    message_time,
    normalize_target,
    sender_label,
)
from runner.workspace import SecretWorkspace

_MAX_LIMIT = 50
_MAX_TEXT = 500
_MAX_RESULT_TEXT = 24_000


class ChatSnapshotSkill(Skill):
    name = "chat_snapshot"

    def validate(self, params: Mapping[str, Any]) -> dict[str, Any]:
        limit = optional_int(params.get("limit", 20), "limit", minimum=1, maximum=_MAX_LIMIT)
        keyword = str(params.get("keyword") or "").strip()
        if len(keyword) > 200:
            raise SkillValidationError("keyword is too long")
        return {
            "target": normalize_target(params.get("target")),
            "limit": limit or 20,
            "keyword": keyword or None,
        }

    async def _snapshot(self, signer: Any, values: dict[str, Any]) -> SkillResult:
        await signer.login(num_of_dialogs=1, print_chat=False)
        messages: list[dict[str, Any]] = []
        total_text = 0
        scan_limit = min(200, max(values["limit"], values["limit"] * 4))
        async with signer.app:
            async for item in signer.app.get_chat_history(values["target"], limit=scan_limit):
                text = message_text(item)
                if values["keyword"] and values["keyword"].casefold() not in text.casefold():
                    continue
                clipped = text[:_MAX_TEXT]
                if total_text + len(clipped) > _MAX_RESULT_TEXT:
                    break
                messages.append({
                    "message_id": message_id(item),
                    "sender": sender_label(item),
                    "time": message_time(item),
                    "text": clipped,
                })
                total_text += len(clipped)
                if len(messages) >= values["limit"]:
                    break
        return SkillResult(
            data={
                "target": str(values["target"]),
                "keyword": values["keyword"],
                "messages": messages,
                "count": len(messages),
            },
            logs=[{
                "level": "info",
                "event": "chat_snapshot_collected",
                "count": len(messages),
                "filtered": bool(values["keyword"]),
            }],
        )

    def execute(self, context: SkillContext, params: Mapping[str, Any]) -> SkillResult:
        values = self.validate(params)
        try:
            with SecretWorkspace(prefix="telegram-snapshot-") as workspace:
                with telegram_environment(context.secrets):
                    signer = build_signer(context, task_name=None, workspace=workspace)
                    return signer.loop.run_until_complete(self._snapshot(signer, values))
        except Exception as exc:
            if isinstance(exc, (SkillError, SkillValidationError)):
                raise
            classified = classify_telegram_exception(exc)
            # The operation is read-only. Transport failures are safe to retry.
            if classified.code == "telegram_transport":
                classified.ambiguous = False
            raise classified from exc


__test__ = {
    "max_limit": _MAX_LIMIT,
    "max_text": _MAX_TEXT,
    "max_result_text": _MAX_RESULT_TEXT,
}
