from __future__ import annotations

import asyncio
from typing import Any

from listener.rules import chat_type_name, message_buttons, message_text, suggested_button
from listener.telegram_runtime import build_client, stop_client


async def inspect_bot_operation(
    job: dict[str, Any],
    *,
    existing_client=None,
) -> dict[str, Any]:
    inspection = job["inspection"]
    account = job["account"]
    target = str(inspection["target"])
    command = str(inspection.get("start_command") or "/start")
    wait_seconds = int(inspection.get("wait_seconds") or 30)

    client = existing_client or build_client(account, suffix="_inspection")
    temporary = existing_client is None
    if temporary:
        await client.start()
    try:
        chat = await client.get_chat(target)
        sent = await client.send_message(target, command)
        sent_id = int(getattr(sent, "id", 0) or 0)
        deadline = asyncio.get_running_loop().time() + wait_seconds
        collected: dict[int, Any] = {}
        first_received_at: float | None = None
        while asyncio.get_running_loop().time() < deadline:
            async for candidate in client.get_chat_history(target, limit=30):
                candidate_id = int(getattr(candidate, "id", 0) or 0)
                if candidate_id <= sent_id:
                    break
                if getattr(candidate, "outgoing", False):
                    continue
                collected[candidate_id] = candidate
            if collected and first_received_at is None:
                first_received_at = asyncio.get_running_loop().time()
            if first_received_at is not None and asyncio.get_running_loop().time() - first_received_at >= 2:
                break
            await asyncio.sleep(1)

        ordered = [collected[key] for key in sorted(collected)]
        replies = [message_text(item)[:500] for item in ordered if message_text(item)]
        buttons: list[str] = []
        for item in ordered:
            for label in message_buttons(item):
                if label not in buttons:
                    buttons.append(label)
        return {
            "chat": {
                "id": str(getattr(chat, "id", "")),
                "username": getattr(chat, "username", None),
                "title": getattr(chat, "title", None) or getattr(chat, "first_name", None),
                "type": chat_type_name(chat),
            },
            "sent_command": command,
            "reply_text": "\n".join(replies[:5])[:2_000],
            "buttons": buttons[:40],
            "suggested_button_text": suggested_button(buttons),
            "reply_received": bool(ordered),
        }
    finally:
        if temporary:
            await stop_client(client)
