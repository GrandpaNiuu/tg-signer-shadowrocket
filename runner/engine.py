from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from typing import Any, Callable

from runner.models import TaskSpec
from runner.redaction import Redactor
from runner.structured_log import StructuredLogger


class SkillExecutionError(RuntimeError):
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


class SkillTimeout(SkillExecutionError):
    def __init__(self, message: str = "skill timed out") -> None:
        super().__init__(
            message,
            code="timeout",
            retryable=True,
            # A forced timeout cannot prove whether Telegram accepted a message.
            ambiguous=True,
        )


def _child_environment() -> dict[str, str]:
    blocked = ("SESSION", "API_HASH", "PASSWORD", "TOKEN", "SECRET", "PHONE_CODE", "2FA")
    return {
        name: value
        for name, value in os.environ.items()
        if not any(marker in name.upper() for marker in blocked)
    }


def execute_in_subprocess(spec: TaskSpec) -> dict[str, Any]:
    command = [sys.executable, "-m", "runner.skill_worker"]
    kwargs: dict[str, Any] = {
        "stdin": subprocess.PIPE,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "env": _child_environment(),
        "text": True,
    }
    if os.name == "posix":
        kwargs["start_new_session"] = True
    process = subprocess.Popen(command, **kwargs)
    payload = json.dumps(spec.child_payload(), ensure_ascii=False, separators=(",", ":"))
    try:
        stdout, stderr = process.communicate(payload, timeout=spec.timeout_seconds)
    except subprocess.TimeoutExpired as exc:
        if os.name == "posix":
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        else:
            process.kill()
        process.communicate()
        raise SkillTimeout() from exc
    redactor = Redactor.from_mapping(spec.child_payload())
    if process.returncode != 0:
        raise SkillExecutionError(
            redactor.text(stderr or "skill subprocess failed")[-1000:],
            code="subprocess_failed",
            retryable=True,
            ambiguous=True,
        )
    try:
        response = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise SkillExecutionError(
            "skill subprocess returned invalid JSON",
            code="invalid_skill_response",
            retryable=True,
            ambiguous=True,
            logs=[{"level": "warning", "message": redactor.text(stderr)[-1000:]}]
            if stderr
            else [],
        ) from exc
    if not response.get("ok"):
        error = response.get("error", {})
        raise SkillExecutionError(
            redactor.text(error.get("message", "skill failed")),
            code=str(error.get("code", "skill_error")),
            retryable=bool(error.get("retryable")),
            ambiguous=bool(error.get("ambiguous")),
            retry_after_seconds=_bounded_retry_after(error.get("retry_after_seconds")),
            logs=redactor.redact(response.get("logs", [])),
        )
    return {
        "data": redactor.redact(response.get("data", {})),
        "logs": redactor.redact(response.get("logs", [])),
    }


class Engine:
    def __init__(
        self,
        worker_client,
        *,
        execute_skill: Callable[[TaskSpec], dict[str, Any]] = execute_in_subprocess,
        sleep: Callable[[float], None] = time.sleep,
        monotonic: Callable[[], float] = time.monotonic,
        wall_clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    ) -> None:
        self.worker_client = worker_client
        self.execute_skill = execute_skill
        self.sleep = sleep
        self.monotonic = monotonic
        self.wall_clock = wall_clock

    def run(self, spec: TaskSpec) -> dict[str, Any]:
        redactor = Redactor.from_mapping(spec.child_payload())
        logger = StructuredLogger(redactor)
        schedule_wait_ms = 0
        scheduled_at = _scheduled_time(spec)
        if scheduled_at is not None:
            wait_seconds = max(0.0, (scheduled_at - self.wall_clock()).total_seconds())
            if wait_seconds > 0:
                schedule_wait_ms = round(wait_seconds * 1000)
                logger.info("schedule_wait", wait_ms=schedule_wait_ms)
                self.sleep(wait_seconds)
        started_at = self.wall_clock()
        schedule_lag_ms = (
            max(0, round((started_at - scheduled_at).total_seconds() * 1000))
            if scheduled_at is not None
            else 0
        )
        started_clock = self.monotonic()
        final_error: dict[str, Any] | None = None
        output: dict[str, Any] = {}
        attempts = 0

        logger.info(
            "task_started",
            run_id=spec.run_id,
            task_id=spec.task_id,
            account_id=spec.account_id,
            skill=spec.skill,
        )
        for attempt in range(1, spec.max_attempts + 1):
            attempts = attempt
            attempt_clock = self.monotonic()
            self._report_attempt(
                spec.run_id,
                {"attempt": attempt, "status": "running", "started_at": self.wall_clock().isoformat()},
                logger,
            )
            try:
                output = self.execute_skill(spec)
                final_error = None
                duration_ms = round((self.monotonic() - attempt_clock) * 1000)
                self._report_attempt(
                    spec.run_id,
                    {
                        "attempt": attempt,
                        "status": "success",
                        "duration_ms": duration_ms,
                        "finished_at": self.wall_clock().isoformat(),
                    },
                    logger,
                )
                logger.info("attempt_succeeded", attempt=attempt, duration_ms=duration_ms)
                break
            except SkillExecutionError as exc:
                duration_ms = round((self.monotonic() - attempt_clock) * 1000)
                final_error = redactor.redact(
                    {
                        "code": exc.code,
                        "message": str(exc),
                        "retryable": exc.retryable,
                        "ambiguous": exc.ambiguous,
                        "retry_after_seconds": exc.retry_after_seconds,
                    }
                )
                self._report_attempt(
                    spec.run_id,
                    {
                        "attempt": attempt,
                        "status": "ambiguous" if exc.ambiguous else "failed",
                        "duration_ms": duration_ms,
                        "finished_at": self.wall_clock().isoformat(),
                        "error": final_error,
                        "logs": redactor.redact(exc.logs),
                    },
                    logger,
                )
                can_retry = (
                    exc.retryable and not exc.ambiguous and attempt < spec.max_attempts
                )
                logger.warning(
                    "attempt_failed",
                    attempt=attempt,
                    duration_ms=duration_ms,
                    error=final_error,
                    will_retry=can_retry,
                )
                if not can_retry:
                    break
                policy_delay = min(
                    60, spec.retry_delay_seconds * (2 ** (attempt - 1))
                )
                self.sleep(max(policy_delay, exc.retry_after_seconds or 0))
            except Exception as exc:
                final_error = redactor.redact(
                    {
                        "code": "runner_internal_error",
                        "message": str(exc) or type(exc).__name__,
                        "retryable": False,
                        "ambiguous": False,
                    }
                )
                logger.error("runner_internal_error", error=final_error)
                break

        finished_at = self.wall_clock()
        result = {
            "run_id": spec.run_id,
            "status": (
                "success"
                if final_error is None
                else "ambiguous"
                if final_error.get("ambiguous")
                else "failed"
            ),
            "started_at": started_at.isoformat(),
            "finished_at": finished_at.isoformat(),
            "duration_ms": round((self.monotonic() - started_clock) * 1000),
            "schedule_lag_ms": schedule_lag_ms,
            "schedule_wait_ms": schedule_wait_ms,
            "attempts": attempts,
            "error": final_error,
            "result": redactor.redact(output.get("data", {})),
            "logs": redactor.redact((output.get("logs", []) + logger.records)[-100:]),
        }
        # First completion is here; the workflow's always() step repeats it idempotently.
        try:
            self.worker_client.complete_task(spec.run_id, result)
            result["callback_pending"] = False
        except Exception as exc:
            # Preserve the Telegram outcome so the workflow finalizer can retry it.
            result["callback_pending"] = True
            logger.warning("completion_callback_failed", message=str(exc))
        logger.info("task_completed", status=result["status"], attempts=attempts)
        return result

    def _report_attempt(self, run_id: str, payload: dict[str, Any], logger) -> None:
        try:
            self.worker_client.report_attempt(run_id, payload)
        except Exception as exc:
            # Attempt telemetry is best effort. The final completion remains mandatory.
            logger.warning("attempt_callback_failed", message=str(exc))

def _scheduled_time(spec: TaskSpec) -> datetime | None:
    if str(spec.metadata.get("trigger", "")).lower() not in {"cron", "schedule"}:
        return None
    value = spec.metadata.get("scheduled_for")
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _bounded_retry_after(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        seconds = int(value)
    except (TypeError, ValueError):
        return None
    return min(max(seconds, 0), 900)
