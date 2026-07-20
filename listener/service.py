from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

from listener import __version__
from listener.inspection import inspect_bot_operation
from listener.manager import RealtimeManager
from listener.worker_client import ListenerWorkerClient

LOGGER = logging.getLogger("telegram-listener.service")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class ListenerService:
    def __init__(
        self,
        worker: ListenerWorkerClient,
        *,
        instance_id: str,
        label: str,
        sync_interval: int = 30,
        heartbeat_interval: int = 60,
        inspection_interval: int = 4,
    ) -> None:
        self.worker = worker
        self.instance_id = instance_id
        self.label = label
        self.sync_interval = sync_interval
        self.heartbeat_interval = heartbeat_interval
        self.inspection_interval = inspection_interval
        self.started_at = utc_now()
        self.stop_event = asyncio.Event()
        self.manager = RealtimeManager(worker)

    async def sync_loop(self) -> None:
        while not self.stop_event.is_set():
            try:
                await self.manager.apply_config(await self.worker.fetch_config())
            except Exception as exc:
                self.manager.last_error = f"config_sync:{type(exc).__name__}"
                LOGGER.warning("Configuration sync failed: %s", exc)
            try:
                await asyncio.wait_for(self.stop_event.wait(), timeout=self.sync_interval)
            except asyncio.TimeoutError:
                pass

    async def heartbeat_loop(self) -> None:
        while not self.stop_event.is_set():
            try:
                await self.worker.heartbeat({
                    "instance_id": self.instance_id,
                    "label": self.label,
                    "version": __version__,
                    "status": "degraded" if self.manager.last_error else "online",
                    "active_accounts": len(self.manager.accounts),
                    "active_rules": self.manager.active_rule_count,
                    "last_error": self.manager.last_error,
                    "started_at": self.started_at,
                })
            except Exception as exc:
                LOGGER.warning("Heartbeat failed: %s", exc)
            try:
                await asyncio.wait_for(self.stop_event.wait(), timeout=self.heartbeat_interval)
            except asyncio.TimeoutError:
                pass

    async def _complete_inspection_failure(self, inspection_id: str, exc: Exception) -> None:
        try:
            await self.worker.complete_inspection(
                inspection_id,
                instance_id=self.instance_id,
                status="failed",
                error_code="telegram_inspection_failed",
                error_message=f"机器人暂时无法识别：{type(exc).__name__}",
            )
        except Exception as callback_error:
            LOGGER.warning("Inspection completion callback failed: %s", callback_error)

    async def inspection_loop(self) -> None:
        while not self.stop_event.is_set():
            try:
                job = await self.worker.claim_inspection(self.instance_id)
                if job:
                    inspection_id = str(job["inspection"]["id"])
                    account_id = str(job["account"]["id"])
                    try:
                        result = await inspect_bot_operation(
                            job,
                            existing_client=self.manager.client_for(account_id),
                        )
                        await self.worker.complete_inspection(
                            inspection_id,
                            instance_id=self.instance_id,
                            status="success",
                            result=result,
                        )
                    except Exception as exc:
                        LOGGER.warning("Inspection failed: %s", type(exc).__name__)
                        await self._complete_inspection_failure(inspection_id, exc)
                    continue
            except Exception as exc:
                LOGGER.warning("Inspection polling failed: %s", exc)
            try:
                await asyncio.wait_for(self.stop_event.wait(), timeout=self.inspection_interval)
            except asyncio.TimeoutError:
                pass

    async def run(self) -> None:
        LOGGER.info("Starting listener instance %s", self.instance_id)
        tasks = [
            asyncio.create_task(self.sync_loop()),
            asyncio.create_task(self.heartbeat_loop()),
            asyncio.create_task(self.inspection_loop()),
        ]
        await self.stop_event.wait()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await self.manager.stop()
        try:
            await self.worker.heartbeat({
                "instance_id": self.instance_id,
                "label": self.label,
                "version": __version__,
                "status": "offline",
                "active_accounts": 0,
                "active_rules": 0,
                "started_at": self.started_at,
            })
        except Exception:
            pass
        await self.worker.close()
