from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

from runner.skills.base import (
    Skill,
    SkillContext,
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
from runner.workspace import SecretWorkspace


class SendTextSkill(Skill):
    name = "send_text"

    def validate(self, params: Mapping[str, Any]) -> dict[str, Any]:
        raw_target = required_text(params.get("target"), "target", maximum=128)
        username_match = re.search(r"\busername:\s*([A-Za-z0-9_]+)", raw_target)
        id_match = re.search(r"\bid:\s*(-?\d+)", raw_target)
        if username_match:
            raw_target = username_match.group(1)
        elif id_match:
            raw_target = id_match.group(1)

        # Preserve the peer-resolution workaround used by the legacy wrapper.
        if raw_target in {"8604751086", "freexzteam_bot", "@freexzteam_bot"}:
            raw_target = "@freexzteam_bot"

        if raw_target.startswith("@"):
            target: str | int = raw_target
        elif re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{4,31}", raw_target):
            target = "@" + raw_target
        else:
            try:
                target = int(raw_target)
            except ValueError as exc:
                raise SkillValidationError(
                    "target must be @username or a numeric chat id"
                ) from exc
        return {
            "target": target,
            "text": required_text(params.get("text"), "text"),
            "message_thread_id": optional_int(
                params.get("message_thread_id"), "message_thread_id", minimum=1
            ),
            "delete_after": optional_int(
                params.get("delete_after"), "delete_after", minimum=0, maximum=86400
            ),
        }

    def execute(self, context: SkillContext, params: Mapping[str, Any]) -> SkillResult:
        values = self.validate(params)
        try:
            with SecretWorkspace(prefix="telegram-send-") as workspace:
                with telegram_environment(context.secrets):
                    signer = build_signer(context, task_name=None, workspace=workspace)
                    signer.app_run(
                        signer.send_text(
                            values["target"],
                            values["text"],
                            values["delete_after"],
                            message_thread_id=values["message_thread_id"],
                        )
                    )
            return SkillResult(data={"delivered": True})
        except Exception as exc:
            from runner.skills.base import SkillError

            if isinstance(exc, SkillError):
                raise
            raise classify_telegram_exception(exc) from exc
