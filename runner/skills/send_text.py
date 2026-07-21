from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from runner.skills.base import (
    Skill,
    SkillContext,
    SkillResult,
    optional_int,
    required_text,
)
from runner.skills.telegram_adapter import (
    build_signer,
    classify_telegram_exception,
    telegram_environment,
)
from runner.skills.telegram_primitives import normalize_target
from runner.workspace import SecretWorkspace


class SendTextSkill(Skill):
    name = "send_text"

    def validate(self, params: Mapping[str, Any]) -> dict[str, Any]:
        return {
            "target": normalize_target(params.get("target")),
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
