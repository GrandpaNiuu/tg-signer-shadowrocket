from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from collections import deque
from dataclasses import dataclass
from typing import Any, Callable

from pyrogram import Client
from pyrogram.handlers import MessageHandler

from listener.event_identity import message_source
from listener.media_feedback import (
    MediaDescriptor,
    forward_message_media,
    media_preview,
    message_media_descriptor,
)
from listener.reply_limits import ReplyLimiter, is_human_sender
from listener.rules import (
    GROUP_TYPES,
    chat_type_name,
    is_own_message,
    keyword_matches,
    message_text,
    selector_matches,
    trigger_matches,
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
    def __init__(self, worker: ListenerWorkerClient, monotonic: Callable[[], float] = time.monotonic) -> None:
        self.worker = worker
        self.accounts: dict[str, ManagedAccount] = {}
        self.rules_by_account: dict[str, list[dict[str, Any]]] = {}
        self.config_signature: str | None = None
        self.last_error: str | None = None
        self._seen_order: deque[tuple[str, str, str]] = deque(maxlen=10_000)
        self._seen: set[tuple[str, str, str]] = set()
        self._reply_limiter = ReplyLimiter(monotonic)

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

    def _allow_reply(self, rule_id: str, chat_id: str, sender_id: str) -> bool:
        return self._reply_limiter.allow(rule_id, chat_id, sender_id)

    async def _report_event(self, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            return await self.worker.record_event(payload)
        except WorkerClientError as exc:
            LOGGER.warning("Event report failed: %s", exc)
            return {}

    async def _report_event_with_media(
        self,
        payload: dict[str, Any],
        client: Client,
        message: Any,
        descriptor: MediaDescriptor | None,
        account_name: str,
    ) -> None:
        receipt = await self._report_event(payload)
        if descriptor is None:
            return
        notification = receipt.get("notification") if isinstance(receipt, dict) else None
        if not isinstance(notification, dict) or notification.get("sent") is not True:
            return
        result = await forward_message_media(
            client,
            message,
            self.worker,
            descriptor=descriptor,
            event=payload,
            receipt_message_id=notification.get("message_id"),
            account_name=account_name,
        )
        if result.get("sent") is not True:
            LOGGER.info(
                "Listener media feedback was not sent for %s: %s",
                payload.get("message_id"),
                result.get("reason", "unknown"),
            )

    async def _reply_target_sent_by_account(self, client: Client, message: Any) -> Any | None:
        replied = getattr(message, "reply_to_message", None)
        if replied is not None:
            return replied if is_own_message(replied) else None
        reply_id = getattr(message, "reply_to_message_id", None)
        chat = getattr(message, "chat", None)
        chat_id = getattr(chat, "id", None)
        if not reply_id or chat_id is None:
            return None
        try:
            replied = await client.get_messages(chat_id, int(reply_id))
        except Exception:
            return None
        return replied if is_own_message(replied) else None

    async def _handle_message(self, account_id: str, _client: Client, message: Any) -> None:
        if getattr(message, "outgoing", False):
            return
        chat = getattr(message, "chat", None)
        if not chat:
            return
        source = message_source(message)
        chat_id = source["chat_id"]
        message_id = str(getattr(message, "id", ""))
        sender = getattr(message, "from_user", None)
        # Human users, anonymous administrators and channel identities are readable.
        # Bots remain excluded from automatic replies to prevent feedback loops.
        if sender is not None and not is_human_sender(sender):
            return
        sender_id = source["sender_id"] or source["sender_label"]
        content = message_text(message)
        descriptor = message_media_descriptor(message)
        preview = content[:600] if content else (media_preview(message, descriptor) if descriptor else "")
        reply_checked = False
        reply_target = None
        for rule in self.rules_by_account.get(account_id, []):
            if not rule.get("enabled", True):
                continue
            if not selector_matches(str(rule.get("chat_selector") or "*"), message):
                continue
            if rule.get("kind") == "group_monitor" and chat_type_name(chat) not in GROUP_TYPES:
                continue
            keyword = str(rule.get("keyword") or "")
            if rule.get("kind") == "keyword_reply":
                mode = str(rule.get("trigger_mode") or "keyword")
                keyword_hit = bool(keyword) and keyword_matches(
                    keyword,
                    content,
                    case_sensitive=bool(rule.get("case_sensitive")),
                )
                reply_hit = False
                if mode in {"reply_to_own", "keyword_or_reply_to_own"}:
                    if not reply_checked:
                        reply_target = await self._reply_target_sent_by_account(_client, message)
                        reply_checked = True
                    reply_hit = reply_target is not None
                if not trigger_matches(mode, keyword_match=keyword_hit, reply_to_own=reply_hit):
                    continue
            else:
                if not keyword_matches(keyword, content, case_sensitive=bool(rule.get("case_sensitive"))):
                    continue
            dedupe = (str(rule["id"]), chat_id, message_id)
            if not self._remember(dedupe):
                continue
            event = {
                "rule_id": rule["id"],
                "account_id": account_id,
                **source,
                "message_id": message_id,
                "message_preview": preview,
                **(descriptor.event_fields() if descriptor else {}),
            }
            if rule.get("kind") == "keyword_reply":
                response = str(rule.get("response_text") or "")
                if not response or not self._allow_reply(str(rule["id"]), chat_id, sender_id):
                    continue
                try:
                    await message.reply_text(response)
                    reasons = []
                    if keyword_hit:
                        reasons.append(f"命中关键词「{keyword[:80]}」")
                    if reply_hit:
                        original = message_text(reply_target)[:100]
                        reasons.append(f"回复了账号发送的消息{f'「{original}」' if original else ''}")
                    reason = "，且".join(reasons) or "命中自动回复规则"
                    event.update({
                        "event_kind": "keyword_replied",
                        "action_summary": f"{reason}；已按规则「{rule.get('name', '')}」回复：{response[:140]}",
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
            managed = self.accounts.get(account_id)
            account_name = managed.name if managed else account_id
            asyncio.create_task(
                self._report_event_with_media(event, _client, message, descriptor, account_name)
            )

    def _callback_for(self, account_id: str):
        async def callback(client_value: Client, message: Any) -> None:
            await self._handle_message(account_id, client_value, message)

        return callback

    async def stop(self) -> None:
        current = list(self.accounts.values())
        self.accounts.clear()
        self.rules_by_account.clear()
        for managed in current:
            await stop_client(managed.client)

    async def apply_config(self, config: dict[str, Any]) -> None:
        stable_config = {
            "accounts": config.get("accounts", []),
            "rules": config.get("rules", []),
        }
        source = json.dumps(stable_config, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        signature = hashlib.sha256(source.encode("utf-8")).hexdigest()
        if signature == self.config_signature:
            return

        await self.stop()
        rules = [item for item in stable_config["rules"] if isinstance(item, dict)]
        for rule in rules:
            self.rules_by_account.setdefault(str(rule.get("account_id")), []).append(rule)

        failures: list[str] = []
        for account in stable_config["accounts"]:
            if not isinstance(account, dict) or not account.get("id"):
                continue
            account_id = str(account["id"])
            client = build_client(account)
            client.add_handler(MessageHandler(self._callback_for(account_id)))
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
