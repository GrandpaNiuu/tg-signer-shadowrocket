from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from collections import deque
from dataclasses import dataclass
from typing import Any

from pyrogram import Client
from pyrogram.handlers import MessageHandler

from listener.rules import (
    GROUP_TYPES,
    chat_type_name,
    keyword_matches,
    message_text,
    selector_matches,
)
from listener.telegram_runtime import build_client, stop_client
from listener.worker_client import ListenerWorkerClient, WorkerClientError

LOGGER = logging.getLogger("telegram-listener.manager")


@dataclass
class ManagedAccount:
    account_id: str
    name: str
    client: Client


class RealtimeManager:
    def __init__(self, worker: ListenerWorkerClient) -> None:
        self.worker = worker
        self.accounts: dict[str, ManagedAccount] = {}
        self.rules_by_account: dict[str, list[dict[str, Any]]] = {}
        self.config_signature: str | None = None
        self.last_error: str | None = None
        self._seen_order: deque[tuple[str, str, str]] = deque(maxlen=10_000)
        self._seen: set[tuple[str, str, str]] = set()

    @property
    def active_rule_count(self) -> int:
        return sum(len(values) for values in self.rules_by_account.values())

    def client_for(self, account_id: str):
        managed = self.accounts.get(account_id)
        return managed.client if managed else None

    def _remember(self, key: tuple[str, str, str]) -> bool:
        if key in self._seen:
            return False
        if len(self._seen_order) == self._seen_order.maxlen:
            oldest = self._seen_order.popleft()
            self._seen.discard(oldest)
        self._seen_order.append(key)
        self._seen.add(key)
        return True

    async def _report_event(self, payload: dict[str, Any]) -> None:
        try:
            await self.worker.record_event(payload)
        except WorkerClientError as exc:
            LOGGER.warning("Event report failed: %s", exc)

    async def _handle_message(self, account_id: str, _client: Client, message: Any) -> None:
        if getattr(message, "outgoing", False):
            return
        chat = getattr(message, "chat", None)
        if not chat:
            return
        chat_id = str(getattr(chat, "id", ""))
        message_id = str(getattr(message, "id", ""))
        sender = getattr(message, "from_user", None)
        sender_id = str(getattr(sender, "id", "") or "")
        content = message_text(message)
        for rule in self.rules_by_account.get(account_id, []):
            if not rule.get("enabled", True):
                continue
            if not selector_matches(str(rule.get("chat_selector") or "*"), message):
                continue
            if rule.get("kind") == "group_monitor" and chat_type_name(chat) not in GROUP_TYPES:
                continue
            if not keyword_matches(
                str(rule.get("keyword") or ""),
                content,
                case_sensitive=bool(rule.get("case_sensitive")),
            ):
                continue
            dedupe = (str(rule["id"]), chat_id, message_id)
            if not self._remember(dedupe):
                continue
            event = {
                "rule_id": rule["id"],
                "account_id": account_id,
                "chat_id": chat_id,
                "sender_id": sender_id,
                "message_id": message_id,
                "message_preview": content[:600],
            }
            if rule.get("kind") == "keyword_reply":
                response = str(rule.get("response_text") or "")
                if not response:
                    continue
                try:
                    await message.reply_text(response)
                    event.update({
                        "event_kind": "keyword_replied",
                        "action_summary": f"已按规则「{rule.get('name', '')}」回复",
                    })
                except Exception as exc:
                    event.update({
                        "event_kind": "listener_error",
                        "action_summary": f"回复失败：{type(exc).__name__}",
                    })
            else:
                event.update({
                    "event_kind": "message_observed",
                    "action_summary": f"命中监控规则「{rule.get('name', '')}」",
                })
            asyncio.create_task(self._report_event(event))

    async def stop(self) -> None:
        current = list(self.accounts.values())
        self.accounts.clear()
        self.rules_by_account.clear()
        for managed in current:
            await stop_client(managed.client)

    async def apply_config(self, config: dict[str, Any]) -> None:
        source = json.dumps(config, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        signature = hashlib.sha256(source.encode("utf-8")).hexdigest()
        if signature == self.config_signature:
            return

        await self.stop()
        rules = [item for item in config.get("rules", []) if isinstance(item, dict)]
        for rule in rules:
            self.rules_by_account.setdefault(str(rule.get("account_id")), []).append(rule)

        failures: list[str] = []
        for account in config.get("accounts", []):
            if not isinstance(account, dict) or not account.get("id"):
                continue
            account_id = str(account["id"])
            client = build_client(account)
            client.add_handler(MessageHandler(
                lambda client_value, message, aid=account_id: self._handle_message(aid, client_value, message)
            ))
            try:
                await client.start()
                self.accounts[account_id] = ManagedAccount(
                    account_id=account_id,
                    name=str(account.get("name") or account_id),
                    client=client,
                )
            except Exception as exc:
                failures.append(f"{account_id}:{type(exc).__name__}")
                await stop_client(client)
                await self._report_event({
                    "account_id": account_id,
                    "event_kind": "listener_error",
                    "action_summary": f"监听账号启动失败：{type(exc).__name__}",
                })

        self.config_signature = signature
        self.last_error = ", ".join(failures)[:500] if failures else None
        LOGGER.info("Configuration applied: %d accounts, %d rules", len(self.accounts), len(rules))
