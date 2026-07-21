from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from runner.skills.base import (
    Skill,
    SkillContext,
    SkillError,
    SkillResult,
    SkillValidationError,
)
from runner.skills.telegram_adapter import (
    build_signer,
    classify_telegram_exception,
    telegram_environment,
)
from runner.workspace import SecretWorkspace


def _display_name(user: Any) -> str | None:
    values = [
        str(getattr(user, "first_name", "") or "").strip(),
        str(getattr(user, "last_name", "") or "").strip(),
    ]
    result = " ".join(value for value in values if value)
    return result or None


class AccountAuditSkill(Skill):
    name = "account_audit"

    def validate(self, params: Mapping[str, Any]) -> dict[str, Any]:
        if params:
            raise SkillValidationError("account_audit does not accept task parameters")
        return {}

    async def _audit(self, signer: Any, context: SkillContext) -> SkillResult:
        proxy_configured = context.secrets.get("proxy") not in (None, "")
        try:
            async with signer.app:
                user = await signer.app.get_me()
        except Exception as exc:
            classified = classify_telegram_exception(exc)
            if classified.code == "flood_wait":
                return SkillResult(
                    data={
                        "healthy": False,
                        "session_valid": None,
                        "get_me_ok": False,
                        "telegram_id": None,
                        "username": None,
                        "display_name": None,
                        "proxy": {
                            "configured": proxy_configured,
                            "connection_ok": True,
                        },
                        "flood": {
                            "observed": True,
                            "retry_after_seconds": classified.retry_after_seconds,
                        },
                    },
                    logs=[{
                        "level": "warning",
                        "event": "account_audit_flood_wait",
                        "retry_after_seconds": classified.retry_after_seconds,
                    }],
                )
            raise
        user_id = getattr(user, "id", None)
        if user is None or user_id is None:
            raise SkillError(
                "Telegram get_me returned no account identity",
                code="account_identity_missing",
                retryable=False,
            )
        username = str(getattr(user, "username", "") or "").strip().lstrip("@") or None
        return SkillResult(
            data={
                "healthy": True,
                "session_valid": True,
                "get_me_ok": True,
                "telegram_id": str(user_id),
                "username": username,
                "display_name": _display_name(user),
                "proxy": {
                    "configured": proxy_configured,
                    "connection_ok": True,
                },
                "flood": {
                    "observed": False,
                    "retry_after_seconds": None,
                },
            },
            logs=[{
                "level": "info",
                "event": "account_audit_completed",
                "get_me_ok": True,
                "proxy_configured": proxy_configured,
            }],
        )

    def execute(self, context: SkillContext, params: Mapping[str, Any]) -> SkillResult:
        self.validate(params)
        try:
            with SecretWorkspace(prefix="telegram-audit-") as workspace:
                with telegram_environment(context.secrets):
                    signer = build_signer(context, task_name=None, workspace=workspace)
                    return signer.loop.run_until_complete(self._audit(signer, context))
        except Exception as exc:
            if isinstance(exc, (SkillError, SkillValidationError)):
                raise
            raise classify_telegram_exception(exc) from exc


__test__ = {"display_name": _display_name}
