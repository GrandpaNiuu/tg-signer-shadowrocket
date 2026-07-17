from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping


ALLOWED_SKILLS = frozenset({"send_text", "tg_signer"})


class ValidationError(ValueError):
    """The Worker returned an invalid or unsafe task claim."""


def _mapping(value: Any, name: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ValidationError(f"{name} must be an object")
    return value


def _text(value: Any, name: str, *, required: bool = True) -> str:
    result = "" if value is None else str(value).strip()
    if required and not result:
        raise ValidationError(f"{name} is required")
    return result


def _integer(
    value: Any,
    name: str,
    *,
    default: int,
    minimum: int,
    maximum: int,
) -> int:
    if value is None or value == "":
        return default
    try:
        result = int(value)
    except (TypeError, ValueError) as exc:
        raise ValidationError(f"{name} must be an integer") from exc
    if not minimum <= result <= maximum:
        raise ValidationError(f"{name} must be between {minimum} and {maximum}")
    return result


@dataclass(frozen=True, slots=True)
class TaskSpec:
    """Validated execution input. Only Worker claims can create this object."""

    run_id: str
    task_id: str
    account_id: str
    skill: str
    params: dict[str, Any]
    secrets: dict[str, Any]
    retry: int = 0
    timeout_seconds: int = 120
    retry_delay_seconds: int = 2
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def max_attempts(self) -> int:
        return self.retry + 1

    @classmethod
    def from_claim(
        cls, claim: Mapping[str, Any], *, expected_run_id: str
    ) -> "TaskSpec":
        root = _mapping(claim, "claim")
        run = _mapping(root.get("run", {}), "run")
        task = _mapping(root.get("task"), "task")
        account = _mapping(root.get("account"), "account")

        run_id = _text(run.get("id", root.get("run_id")), "run.id")
        if run_id != expected_run_id:
            raise ValidationError("claimed run id does not match workflow input")

        skill_value = task.get("skill", task.get("skill_name"))
        if isinstance(skill_value, Mapping):
            skill_value = skill_value.get("slug", skill_value.get("name"))
        skill = _text(skill_value, "task.skill").lower().replace("-", "_")
        if skill == "task":
            skill = "tg_signer"
        if skill not in ALLOWED_SKILLS:
            raise ValidationError(f"unsupported skill: {skill}")

        raw_params = task.get("params", task.get("config", {}))
        params = dict(_mapping(raw_params or {}, "task.params"))
        # Compatibility with the human-facing task columns in D1.
        aliases = {
            "bot": "target",
            "command": "text",
            "thread": "message_thread_id",
            "thread_id": "message_thread_id",
            "delete_after": "delete_after",
            "delete_after_seconds": "delete_after",
            "task_name": "task_name",
            "import_blob": "import_blob",
        }
        for source, target in aliases.items():
            if target not in params and task.get(source) not in (None, ""):
                params[target] = task[source]
        if skill == "tg_signer" and not params.get("task_name"):
            # During migration the generic Command column carries the old
            # TG_SIGNER_TASK_NAME. Canonical claims should set params.task_name.
            params["task_name"] = task.get("command", params.get("text"))
        for key in ("message_thread_id", "delete_after", "num_of_dialogs"):
            if params.get(key) not in (None, ""):
                try:
                    params[key] = int(params[key])
                except (TypeError, ValueError) as exc:
                    raise ValidationError(f"task.params.{key} must be an integer") from exc

        account_secrets = account.get("secrets", {})
        secrets = dict(_mapping(account_secrets or {}, "account.secrets"))
        root_secrets = root.get("secrets", {})
        secrets.update(_mapping(root_secrets or {}, "secrets"))
        for key in ("session_string", "api_id", "api_hash", "proxy"):
            if key not in secrets and account.get(key) not in (None, ""):
                secrets[key] = account[key]
        if not _text(secrets.get("session_string"), "account.session_string"):
            raise ValidationError("account.session_string is required")

        retry = _integer(
            task.get("retry", task.get("retry_count")),
            "task.retry",
            default=0,
            minimum=0,
            maximum=10,
        )
        timeout = _integer(
            task.get("timeout", task.get("timeout_seconds")),
            "task.timeout",
            default=120,
            minimum=5,
            maximum=900,
        )
        retry_delay = _integer(
            task.get("retry_delay_seconds"),
            "task.retry_delay_seconds",
            default=2,
            minimum=0,
            maximum=60,
        )

        return cls(
            run_id=run_id,
            task_id=_text(task.get("id"), "task.id"),
            account_id=_text(account.get("id"), "account.id"),
            skill=skill,
            params=params,
            secrets=secrets,
            retry=retry,
            timeout_seconds=timeout,
            retry_delay_seconds=retry_delay,
            metadata={
                "scheduled_for": run.get("scheduled_for"),
                "trigger": run.get("trigger", "workflow_dispatch"),
            },
        )

    def child_payload(self) -> dict[str, Any]:
        return {
            "skill": self.skill,
            "params": self.params,
            "secrets": self.secrets,
            "account_id": self.account_id,
            "task_id": self.task_id,
        }
