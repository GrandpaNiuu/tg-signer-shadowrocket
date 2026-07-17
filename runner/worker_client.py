from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping
from typing import Any, Callable


class WorkerAPIError(RuntimeError):
    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


class WorkerClient:
    def __init__(
        self,
        base_url: str,
        token_provider,
        *,
        opener: Callable = urllib.request.urlopen,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        if not self.base_url.startswith("https://"):
            raise ValueError("WORKER_URL must use https")
        self.token_provider = token_provider
        self.opener = opener
        self.sleep = sleep

    def claim_task(self, run_id: str) -> dict[str, Any]:
        return self._request(
            "POST", f"/api/runner/runs/{_part(run_id)}/claim", {}, retries=1
        )

    def report_attempt(self, run_id: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        return self._request(
            "POST", f"/api/runner/runs/{_part(run_id)}/attempts", payload
        )

    def complete_task(self, run_id: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        return self._request(
            "POST", f"/api/runner/runs/{_part(run_id)}/complete", payload, retries=3
        )

    def claim_login(self, flow_id: str) -> dict[str, Any]:
        return self._request(
            "POST", f"/api/runner/login-flows/{_part(flow_id)}/claim", {}, retries=1
        )

    def report_login_event(
        self, flow_id: str, payload: Mapping[str, Any]
    ) -> dict[str, Any]:
        return self._request(
            "POST",
            f"/api/runner/login-flows/{_part(flow_id)}/events",
            payload,
            retries=1,
        )

    def claim_login_input(self, flow_id: str, expected: str) -> dict[str, Any] | None:
        response = self._request(
            "POST",
            f"/api/runner/login-flows/{_part(flow_id)}/input/claim",
            {"expected": expected},
            retries=1,
        )
        if response.get("status") in {"pending", "waiting"}:
            return None
        return response

    def claim_login_resend(self, flow_id: str) -> bool:
        response = self.claim_login_input(flow_id, "resend")
        if response is None:
            return False
        if response.get("kind") != "resend" or response.get("value") != "requested":
            raise WorkerAPIError("Worker returned an invalid resend control")
        return True

    def complete_login(
        self, flow_id: str, payload: Mapping[str, Any]
    ) -> dict[str, Any]:
        return self._request(
            "POST",
            f"/api/runner/login-flows/{_part(flow_id)}/complete",
            payload,
            retries=3,
        )

    def _request(
        self,
        method: str,
        path: str,
        payload: Mapping[str, Any],
        *,
        retries: int = 2,
    ) -> dict[str, Any]:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        last_error: Exception | None = None
        for attempt in range(retries):
            request = urllib.request.Request(
                self.base_url + path,
                data=body,
                method=method,
                headers={
                    "Authorization": f"Bearer {self.token_provider.token()}",
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "User-Agent": "telegram-checkin-runner/0.1",
                },
            )
            try:
                with self.opener(request, timeout=30) as response:
                    raw = response.read()
                    if not raw:
                        return {}
                    value = json.loads(raw.decode("utf-8"))
                    if not isinstance(value, dict):
                        raise WorkerAPIError("Worker returned a non-object JSON response")
                    return value
            except urllib.error.HTTPError as exc:
                last_error = WorkerAPIError(
                    f"Worker API returned HTTP {exc.code}", status=exc.code
                )
                if exc.code not in {429, 500, 502, 503, 504}:
                    break
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
                last_error = exc
            if attempt + 1 < retries:
                self.sleep(2**attempt)
        if isinstance(last_error, WorkerAPIError):
            raise last_error
        raise WorkerAPIError("Worker API request failed") from last_error


def _part(value: str) -> str:
    return urllib.parse.quote(str(value), safe="")
