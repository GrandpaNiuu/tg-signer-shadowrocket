from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any

from runner.engine import Engine
from runner.models import TaskSpec
from runner.redaction import Redactor


class ThreadsafeWorkerCallbacks:
    """Expose the synchronous Engine callback contract over the Listener async client."""

    def __init__(self, worker, loop: asyncio.AbstractEventLoop, timeout_seconds: float = 40.0) -> None:
        self.worker = worker
        self.loop = loop
        self.timeout_seconds = timeout_seconds

    def _wait(self, coroutine):
        future = asyncio.run_coroutine_threadsafe(coroutine, self.loop)
        return future.result(timeout=self.timeout_seconds)

    def report_attempt(self, run_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self._wait(self.worker.report_task_attempt(run_id, payload))

    def complete_task(self, run_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self._wait(self.worker.complete_task(run_id, payload))


def _failure(run_id: str, code: str, message: str) -> dict[str, Any]:
    now = datetime.now(timezone.utc).isoformat()
    return {
        "run_id": run_id,
        "status": "failed",
        "started_at": now,
        "finished_at": now,
        "duration_ms": 0,
        "attempts": 0,
        "error": {
            "code": code,
            "message": message,
            "retryable": False,
            "ambiguous": False,
        },
        "result": {},
        "logs": [],
    }


def execute_claimed_task(
    claim: dict[str, Any],
    worker,
    loop: asyncio.AbstractEventLoop,
) -> dict[str, Any]:
    run_id = str((claim.get("run") or {}).get("id") or "")
    callbacks = ThreadsafeWorkerCallbacks(worker, loop)
    redactor = Redactor.from_mapping(claim)
    try:
        spec = TaskSpec.from_claim(claim, expected_run_id=run_id)
        return Engine(callbacks).run(spec)
    except Exception as exc:
        result = _failure(
            run_id,
            "listener_task_start_failed",
            redactor.text(str(exc) or type(exc).__name__),
        )
        if run_id:
            try:
                callbacks.complete_task(run_id, result)
                result["callback_pending"] = False
            except Exception:
                result["callback_pending"] = True
        return result
