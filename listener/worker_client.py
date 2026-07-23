from __future__ import annotations

import asyncio
from pathlib import Path
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
            "user-agent": "telegram-realtime-listener/0.4",
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

    @staticmethod
    async def _response_payload(response: httpx.Response) -> Any:
        try:
            payload = response.json()
        except ValueError as exc:
            raise WorkerClientError("Worker returned invalid JSON") from exc
        return payload.get("data") if isinstance(payload, dict) and "data" in payload else payload

    async def _request(self, method: str, path: str, *, json: dict[str, Any] | None = None) -> Any:
        try:
            response = await self._client.request(method, path, json=json)
        except (httpx.HTTPError, asyncio.TimeoutError) as exc:
            raise WorkerClientError(f"Worker request failed: {type(exc).__name__}") from exc
        if response.status_code < 200 or response.status_code >= 300:
            request_id = response.headers.get("x-request-id")
            suffix = f" (request {request_id})" if request_id else ""
            raise WorkerClientError(f"Worker returned HTTP {response.status_code}{suffix}")
        return await self._response_payload(response)

    async def fetch_config(self) -> dict[str, Any]:
        value = await self._request("GET", "/api/listener/v1/config")
        return value if isinstance(value, dict) else {"accounts": [], "rules": [], "leader": False}

    async def heartbeat(self, payload: dict[str, Any]) -> dict[str, Any]:
        value = await self._request("POST", "/api/listener/v1/heartbeat", json=payload)
        return value if isinstance(value, dict) else {}

    async def claim_task(self, instance_id: str) -> dict[str, Any] | None:
        value = await self._request(
            "POST",
            "/api/listener/v1/runs/claim",
            json={"instance_id": instance_id},
        )
        return value if isinstance(value, dict) else None

    async def report_task_attempt(self, run_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        value = await self._request(
            "POST",
            f"/api/listener/v1/runs/{run_id}/attempts",
            json=payload,
        )
        return value if isinstance(value, dict) else {}

    async def complete_task(self, run_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        value = await self._request(
            "POST",
            f"/api/listener/v1/runs/{run_id}/complete",
            json=payload,
        )
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

    async def record_event(self, payload: dict[str, Any]) -> dict[str, Any]:
        value = await self._request("POST", "/api/listener/v1/events", json=payload)
        return value if isinstance(value, dict) else {}

    async def upload_event_media(
        self,
        path: Path,
        *,
        media_kind: str,
        media_file_name: str,
        media_mime_type: str,
        receipt_message_id: int | None,
        account_name: str,
        chat_label: str,
        sender_label: str,
        caption: str,
    ) -> dict[str, Any]:
        data = {
            "media_kind": media_kind,
            "media_file_name": media_file_name,
            "account_name": account_name,
            "chat_label": chat_label,
            "sender_label": sender_label,
            "caption": caption,
            "receipt_message_id": str(receipt_message_id or ""),
        }
        try:
            with path.open("rb") as handle:
                response = await self._client.post(
                    "/api/listener/v1/events",
                    data=data,
                    files={
                        "file": (
                            media_file_name or path.name,
                            handle,
                            media_mime_type or "application/octet-stream",
                        ),
                    },
                    timeout=httpx.Timeout(max(self.timeout_seconds, 60.0)),
                )
        except (httpx.HTTPError, asyncio.TimeoutError, OSError) as exc:
            raise WorkerClientError(f"Listener media upload failed: {type(exc).__name__}") from exc
        if response.status_code < 200 or response.status_code >= 300:
            request_id = response.headers.get("x-request-id")
            suffix = f" (request {request_id})" if request_id else ""
            raise WorkerClientError(f"Worker returned HTTP {response.status_code}{suffix}")
        value = await self._response_payload(response)
        return value if isinstance(value, dict) else {}

    async def claim_media_upload(self, instance_id: str) -> dict[str, Any] | None:
        value = await self._request(
            "POST",
            "/api/listener/v1/media-uploads/claim",
            json={"instance_id": instance_id},
        )
        return value if isinstance(value, dict) else None

    async def download_media_upload(self, upload_id: str, target: Path, *, expected_size: int) -> None:
        received = 0
        try:
            async with self._client.stream(
                "GET",
                f"/api/listener/v1/media-uploads/{upload_id}/content",
            ) as response:
                if response.status_code < 200 or response.status_code >= 300:
                    raise WorkerClientError(f"Worker returned HTTP {response.status_code}")
                with target.open("wb") as handle:
                    async for chunk in response.aiter_bytes():
                        received += len(chunk)
                        if expected_size > 0 and received > expected_size:
                            raise WorkerClientError("Worker returned an oversized media upload")
                        handle.write(chunk)
        except (httpx.HTTPError, asyncio.TimeoutError, OSError) as exc:
            raise WorkerClientError(f"Media download failed: {type(exc).__name__}") from exc
        if expected_size < 1 or received != expected_size:
            try:
                target.unlink(missing_ok=True)
            except OSError:
                pass
            raise WorkerClientError("Worker returned an incomplete media upload")

    async def complete_media_upload(
        self,
        upload_id: str,
        *,
        status: str,
        source_message_id: int | None = None,
        error_code: str | None = None,
        error_message: str | None = None,
    ) -> None:
        payload: dict[str, Any] = {
            "instance_id": self.instance_id,
            "status": status,
        }
        if source_message_id is not None:
            payload["source_message_id"] = source_message_id
        if error_code:
            payload["error_code"] = error_code
        if error_message:
            payload["error_message"] = error_message
        await self._request(
            "POST",
            f"/api/listener/v1/media-uploads/{upload_id}/complete",
            json=payload,
        )
