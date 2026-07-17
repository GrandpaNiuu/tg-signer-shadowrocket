from __future__ import annotations

import contextlib
import io
import json
import sys
import traceback
from collections.abc import Mapping
from typing import Any

from runner.redaction import Redactor
from runner.skills import build_registry
from runner.skills.base import SkillContext, SkillError, SkillValidationError


def execute(payload: Mapping[str, Any]) -> dict[str, Any]:
    secrets = payload.get("secrets", {})
    if not isinstance(secrets, Mapping):
        return _error("invalid secrets object", "invalid_payload")
    redactor = Redactor.from_mapping(payload)
    captured_out = io.StringIO()
    captured_error = io.StringIO()
    try:
        skill = build_registry().get(str(payload.get("skill", "")))
        context = SkillContext(
            account_id=str(payload.get("account_id", "")),
            task_id=str(payload.get("task_id", "")),
            secrets=secrets,
        )
        with contextlib.redirect_stdout(captured_out), contextlib.redirect_stderr(captured_error):
            result = skill.execute(context, payload.get("params", {}))
        logs = _captured_logs(captured_out, captured_error, redactor)
        return {
            "ok": True,
            "data": redactor.redact(result.data),
            "logs": redactor.redact(result.logs + logs),
        }
    except (SkillError, SkillValidationError) as exc:
        code = getattr(exc, "code", "invalid_skill_parameters")
        return _error(
            redactor.text(exc),
            code,
            retryable=bool(getattr(exc, "retryable", False)),
            ambiguous=bool(getattr(exc, "ambiguous", False)),
            retry_after_seconds=getattr(exc, "retry_after_seconds", None),
            logs=_captured_logs(captured_out, captured_error, redactor),
        )
    except Exception as exc:
        # A short, sanitized diagnostic is useful; never serialize locals or payload.
        diagnostic = "".join(traceback.format_exception_only(type(exc), exc)).strip()
        return _error(
            redactor.text(diagnostic),
            "skill_internal_error",
            logs=_captured_logs(captured_out, captured_error, redactor),
        )


def _captured_logs(out: io.StringIO, error: io.StringIO, redactor: Redactor):
    records = []
    for level, value in (("info", out.getvalue()), ("warning", error.getvalue())):
        sanitized = redactor.text(value).strip()
        if sanitized:
            records.append({"level": level, "message": sanitized[-4000:]})
    return records


def _error(
    message: str,
    code: str,
    *,
    retryable: bool = False,
    ambiguous: bool = False,
    retry_after_seconds: int | None = None,
    logs: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "ok": False,
        "error": {
            "message": str(message),
            "code": code,
            "retryable": retryable,
            "ambiguous": ambiguous,
            "retry_after_seconds": retry_after_seconds,
        },
        "logs": logs or [],
    }


def main() -> int:
    # The full task, including the Session, is accepted only over an anonymous pipe.
    raw = sys.stdin.buffer.read(2 * 1024 * 1024 + 1)
    if len(raw) > 2 * 1024 * 1024:
        response = _error("skill payload is too large", "payload_too_large")
    else:
        try:
            payload = json.loads(raw.decode("utf-8"))
            if not isinstance(payload, Mapping):
                raise ValueError("payload must be an object")
            response = execute(payload)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            response = _error(str(exc), "invalid_payload")
    sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
