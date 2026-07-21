from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Mapping


class SkillValidationError(ValueError):
    pass


class SkillError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        code: str = "skill_error",
        retryable: bool = False,
        ambiguous: bool = False,
        retry_after_seconds: int | None = None,
        logs: list[dict[str, Any]] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.ambiguous = ambiguous
        self.retry_after_seconds = retry_after_seconds
        self.logs = logs or []


@dataclass(slots=True)
class SkillContext:
    account_id: str
    task_id: str
    secrets: Mapping[str, Any]


@dataclass(slots=True)
class SkillResult:
    data: dict[str, Any] = field(default_factory=dict)
    logs: list[dict[str, Any]] = field(default_factory=list)


class Skill(ABC):
    name: str

    @abstractmethod
    def validate(self, params: Mapping[str, Any]) -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    def execute(self, context: SkillContext, params: Mapping[str, Any]) -> SkillResult:
        raise NotImplementedError


def optional_int(
    value: Any, name: str, *, minimum: int = 0, maximum: int = 2_147_483_647
) -> int | None:
    if value is None or value == "":
        return None
    try:
        result = int(value)
    except (TypeError, ValueError) as exc:
        raise SkillValidationError(f"{name} must be an integer") from exc
    if result < minimum or result > maximum:
        raise SkillValidationError(f"{name} is out of range")
    return result


def required_text(value: Any, name: str, *, maximum: int = 4096) -> str:
    result = "" if value is None else str(value).strip()
    if not result:
        raise SkillValidationError(f"{name} is required")
    if len(result) > maximum:
        raise SkillValidationError(f"{name} is too long")
    return result
