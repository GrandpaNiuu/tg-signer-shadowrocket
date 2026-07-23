from __future__ import annotations

import logging
from datetime import datetime
from typing import TYPE_CHECKING, Any

from listener.telegram_runtime import build_client, stop_client

if TYPE_CHECKING:
    from listener.worker_client import ListenerWorkerClient

LOGGER = logging.getLogger("telegram-listener.dialog-directory")
MAX_DIALOGS = 500

_TYPE_LABELS = {
    "private": "好友",
    "bot": "机器人",
    "group": "群组",
    "supergroup": "超级群组",
    "channel": "频道",
}


def _chat_type(chat: Any) -> str:
    raw = str(getattr(chat, "type", "private") or "private")
    value = raw.rsplit(".", 1)[-1].lower()
    if value == "private" and bool(getattr(chat, "is_bot", False)):
        return "bot"
    return value if value in _TYPE_LABELS else "private"


def _username(chat: Any) -> str | None:
    value = str(getattr(chat, "username", "") or "").strip().lstrip("@")
    return value[:64] or None


def _title(chat: Any, peer_type: str) -> str:
    title = str(getattr(chat, "title", "") or "").strip()
    if title:
        return title[:160]
    name = " ".join(
        str(value or "").strip()
        for value in (getattr(chat, "first_name", None), getattr(chat, "last_name", None))
        if str(value or "").strip()
    )
    if name:
        return name[:160]
    username = _username(chat)
    if username:
        return f"@{username}"
    return f"{_TYPE_LABELS[peer_type]}（名称未公开）"


def _writable(chat: Any, peer_type: str) -> bool:
    if peer_type != "channel":
        return True
    privileges = getattr(chat, "privileges", None)
    return bool(
        getattr(privileges, "can_post_messages", False)
        or getattr(privileges, "can_send_messages", False)
    )


def _last_message_at(dialog: Any) -> str | None:
    message = getattr(dialog, "top_message", None)
    value = getattr(message, "date", None)
    if isinstance(value, datetime):
        return value.isoformat()
    return None


def dialog_record(dialog: Any) -> dict[str, Any] | None:
    chat = getattr(dialog, "chat", None)
    peer_id = str(getattr(chat, "id", "") or "").strip()
    if not peer_id or not peer_id.lstrip("-").isdigit():
        return None
    peer_type = _chat_type(chat)
    username = _username(chat)
    title = _title(chat, peer_type)
    target = f"@{username}" if username else peer_id
    type_label = _TYPE_LABELS[peer_type]
    identity = f"@{username}" if username and title != f"@{username}" else ""
    label = f"{title}{f'（{identity}）' if identity else ''} · {type_label}"
    return {
        "peer_id": peer_id,
        "target": target,
        "peer_type": peer_type,
        "title": title,
        "username": username,
        "label": label[:240],
        "is_writable": _writable(chat, peer_type),
        "last_message_at": _last_message_at(dialog),
    }


async def collect_dialogs(client: Any, limit: int = MAX_DIALOGS) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    async for dialog in client.get_dialogs(limit=limit):
        record = dialog_record(dialog)
        if record is not None:
            records.append(record)
    return records


async def process_dialog_sync(
    worker: "ListenerWorkerClient",
    instance_id: str,
    manager: Any,
) -> bool:
    try:
        job = await worker.claim_dialog_sync(instance_id)
    except Exception as exc:
        LOGGER.warning("Dialog sync claim failed: %s", type(exc).__name__)
        return False
    if not job:
        return False

    sync = job.get("sync") if isinstance(job, dict) else None
    account = job.get("account") if isinstance(job, dict) else None
    sync_id = str((sync or {}).get("id") or "")
    account_id = str((sync or {}).get("account_id") or (account or {}).get("id") or "")
    if not sync_id or not account_id or not isinstance(account, dict):
        return False

    client = manager.client_for(account_id) if manager is not None else None
    temporary = client is None
    if temporary:
        client = build_client(account)
    try:
        if temporary:
            await client.start()
        dialogs = await collect_dialogs(client)
        await worker.complete_dialog_sync(
            sync_id,
            instance_id=instance_id,
            status="success",
            dialogs=dialogs,
        )
        LOGGER.info("Dialog directory synchronized: %s (%d dialogs)", account_id, len(dialogs))
        return True
    except Exception as exc:
        LOGGER.warning("Dialog directory synchronization failed: %s", type(exc).__name__)
        try:
            await worker.complete_dialog_sync(
                sync_id,
                instance_id=instance_id,
                status="failed",
                error_code="telegram_dialog_sync_failed",
                error_message=f"Telegram 会话同步失败：{type(exc).__name__}",
            )
        except Exception:
            pass
        return False
    finally:
        if temporary:
            await stop_client(client)


__all__ = ["MAX_DIALOGS", "collect_dialogs", "dialog_record", "process_dialog_sync"]
