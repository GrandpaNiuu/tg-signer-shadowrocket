from __future__ import annotations

import asyncio
from typing import Any

import httpx


class WorkerClientError(RuntimeError):
    pass


class ListenerWorkerClient:
    def __init__(
        self,
        worker_url: str,
        api_token: str,
        *,
        instance_id: str | None = None,
        timeout_seconds: float = 20.0,
    ) -> None:
        self.base_url = worker_url.rstrip("/")
        self.api_token = api_token
        self.instance_id = (instance_id or "").strip()
        self.timeout_seconds = timeout_seconds
        headers = {
            "authorization": f"Bearer {api_token}",
            "accept": "application/json",
            "user-agent": "telegram-realtime-listener/0.2",
        }
        if self.instance_id:
            headers["x-listener-instance-id"] = self.instance_id
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            timeout=httpx.Timeout(timeout_seconds),
            headers=headers,
            follow_redirects=False,
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def _request(self, method: str, path: str, *, json: dict[str, Any] | None = None) -> Any:
        try:
            response = await self._client.request(method, path, json=json)
        except (httpx.HTTPError, asyncio.TimeoutError) as exc:
            raise WorkerClientError(f"Worker request failed: {type(exc).__name__}") from exc
        if response.status_code < 200 or response.status_code >= 300:
            request_id = response.headers.get("x-request-id")
            suffix = f" (request {request_id})" if request_id else ""
            raise WorkerClientError(f"Worker returned HTTP {response.status_code}{suffix}")
        try:
            payload = response.json()
        except ValueError as exc:
            raise WorkerClientError("Worker returned invalid JSON") from exc
        return payload.get("data") if isinstance(payload, dict) and "data" in payload else payload

    async def fetch_config(self) -> dict[str, Any]:
        value = await self._request("GET", "/api/listener/v1/config")
        return value if isinstance(value, dict) else {"accounts": [], "rules": [], "leader": False}

    async def heartbeat(self, payload: dict[str, Any]) -> dict[str, Any]:
        value = await self._request("POST", "/api/listener/v1/heartbeat", json=payload)
        return value if isinstance(value, dict) else {}

    async def claim_inspection(self, instance_id: str) -> dict[str, Any] | None:
        value = await self._request(
            "POST",
            "/api/listener/v1/inspections/claim",
            json={"instance_id": instance_id},
        )
        return value if isinstance(value, dict) else None

    async def complete_inspection(
        self,
        inspection_id: str,
        *,
        instance_id: str,
        status: str,
        result: dict[str, Any] | None = None,
        error_code: str | None = None,
        error_message: str | None = None,
    ) -> None:
        payload: dict[str, Any] = {
            "instance_id": instance_id,
            "status": status,
        }
        if result is not None:
            payload["result"] = result
        if error_code:
            payload["error_code"] = error_code
        if error_message:
            payload["error_message"] = error_message
        await self._request(
            "POST",
            f"/api/listener/v1/inspections/{inspection_id}/complete",
            json=payload,
        )

    async def record_event(self, payload: dict[str, Any]) -> None:
        await self._request("POST", "/api/listener/v1/events", json=payload)
