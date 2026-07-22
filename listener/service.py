from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

from pyrogram.handlers import MessageHandler

from listener import __version__
from listener.inspection import inspect_bot_operation
from listener.manager import ManagedAccount, RealtimeManager
from listener.media_upload import stage_media_upload
from listener.task_execution import execute_claimed_task
from listener.telegram_runtime import build_client, stop_client
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
        task_interval: int = 2,
        media_upload_interval: int = 2,
    ) -> None:
        self.worker = worker
        self.instance_id = instance_id
        self.label = label
        self.sync_interval = sync_interval
        self.heartbeat_interval = heartbeat_interval
        self.inspection_interval = inspection_interval
        self.task_interval = task_interval
        self.media_upload_interval = media_upload_interval
        self.started_at = utc_now()
        self.stop_event = asyncio.Event()
        self.manager = RealtimeManager(worker)
        self.manager_lock = asyncio.Lock()
        self.is_leader = False

    async def sync_loop(self) -> None:
        while not self.stop_event.is_set():
            try:
                config = await self.worker.fetch_config()
                self.is_leader = config.get("leader") is not False
                async with self.manager_lock:
                    await self.manager.apply_config(config)
                if not self.is_leader:
                    self.manager.last_error = None
                    LOGGER.info("Listener instance %s is in standby mode", self.instance_id)
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
                if not self.is_leader:
                    await asyncio.wait_for(self.stop_event.wait(), timeout=self.inspection_interval)
                    continue
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
            except asyncio.TimeoutError:
                pass
            except Exception as exc:
                LOGGER.warning("Inspection polling failed: %s", exc)
            try:
                await asyncio.wait_for(self.stop_event.wait(), timeout=self.inspection_interval)
            except asyncio.TimeoutError:
                pass

    @staticmethod
    def _runtime_account(claim: dict[str, Any]) -> dict[str, Any]:
        account = dict(claim.get("account") or {})
        secrets = dict(account.pop("secrets", {}) or {})
        return {**account, **secrets}

    async def _retry_pending_completion(self, run_id: str, result: dict[str, Any]) -> None:
        if not result.get("callback_pending"):
            return
        try:
            await self.worker.complete_task(run_id, result)
            result["callback_pending"] = False
            LOGGER.info("Recovered completion callback for scheduled run %s", run_id)
        except Exception as exc:
            self.manager.last_error = f"task_callback:{run_id}:{type(exc).__name__}"
            LOGGER.warning("Scheduled run %s completion callback remains pending: %s", run_id, type(exc).__name__)

    async def _execute_task(self, claim: dict[str, Any]) -> None:
        run_id = str((claim.get("run") or {}).get("id") or "")
        account = self._runtime_account(claim)
        account_id = str(account.get("id") or "")
        if not run_id or not account_id:
            LOGGER.warning("Listener task claim is missing run or account id")
            return

        async with self.manager_lock:
            managed = self.manager.accounts.pop(account_id, None)
            if managed:
                await stop_client(managed.client)
                LOGGER.info("Paused realtime account %s for scheduled run %s", account_id, run_id)
            try:
                loop = asyncio.get_running_loop()
                result = await asyncio.to_thread(execute_claimed_task, claim, self.worker, loop)
                await self._retry_pending_completion(run_id, result)
                LOGGER.info("Scheduled run %s completed with status %s", run_id, result.get("status"))
            finally:
                try:
                    client = build_client(account, suffix="_resume")
                    client.add_handler(MessageHandler(self.manager._callback_for(account_id)))
                    await client.start()
                    self.manager.accounts[account_id] = ManagedAccount(
                        account_id=account_id,
                        name=str(account.get("name") or account_id),
                        client=client,
                    )
                    if self.manager.last_error and self.manager.last_error.startswith(("task_resume:", "task_callback:")):
                        self.manager.last_error = None
                    LOGGER.info("Resumed realtime account %s after scheduled run %s", account_id, run_id)
                except Exception as exc:
                    self.manager.last_error = f"task_resume:{account_id}:{type(exc).__name__}"
                    self.manager.config_signature = None
                    LOGGER.warning("Could not resume realtime account %s: %s", account_id, type(exc).__name__)

    async def task_loop(self) -> None:
        while not self.stop_event.is_set():
            try:
                if not self.is_leader:
                    await asyncio.wait_for(self.stop_event.wait(), timeout=self.task_interval)
                    continue
                claim = await self.worker.claim_task(self.instance_id)
                if claim:
                    await self._execute_task(claim)
                    continue
            except asyncio.TimeoutError:
                pass
            except Exception as exc:
                LOGGER.warning("Scheduled task polling failed: %s", exc)
            try:
                await asyncio.wait_for(self.stop_event.wait(), timeout=self.task_interval)
            except asyncio.TimeoutError:
                pass

    async def _execute_media_upload(self, job: dict[str, Any]) -> None:
        upload = dict(job.get("upload") or {})
        account = dict(job.get("account") or {})
        upload_id = str(upload.get("id") or "")
        account_id = str(account.get("id") or "")
        if not upload_id or not account_id:
            LOGGER.warning("Media upload claim is missing upload or account id")
            return
        async with self.manager_lock:
            try:
                await stage_media_upload(
                    job,
                    self.worker,
                    existing_client=self.manager.client_for(account_id),
                )
                LOGGER.info("Media upload %s was staged in Telegram Saved Messages", upload_id)
            except Exception as exc:
                self.manager.last_error = f"media_upload:{upload_id}:{type(exc).__name__}"
                LOGGER.warning("Media upload %s failed: %s", upload_id, type(exc).__name__)

    async def media_upload_loop(self) -> None:
        while not self.stop_event.is_set():
            try:
                if not self.is_leader:
                    await asyncio.wait_for(self.stop_event.wait(), timeout=self.media_upload_interval)
                    continue
                job = await self.worker.claim_media_upload(self.instance_id)
                if job:
                    await self._execute_media_upload(job)
                    continue
            except asyncio.TimeoutError:
                pass
            except Exception as exc:
                LOGGER.warning("Media upload polling failed: %s", exc)
            try:
                await asyncio.wait_for(self.stop_event.wait(), timeout=self.media_upload_interval)
            except asyncio.TimeoutError:
                pass

    async def run(self) -> None:
        LOGGER.info("Starting listener instance %s", self.instance_id)
        tasks = [
            asyncio.create_task(self.sync_loop()),
            asyncio.create_task(self.heartbeat_loop()),
            asyncio.create_task(self.inspection_loop()),
            asyncio.create_task(self.task_loop()),
            asyncio.create_task(self.media_upload_loop()),
        ]
        await self.stop_event.wait()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        async with self.manager_lock:
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
