from __future__ import annotations

from typing import Any

from pyrogram import Client

from listener.rules import parse_proxy


def build_client(account: dict[str, Any], *, suffix: str = "") -> Client:
    name = "listener_" + "".join(
        character if character.isalnum() else "_"
        for character in f"{account['id']}{suffix}"
    )[:56]
    return Client(
        name,
        api_id=int(account["api_id"]),
        api_hash=str(account["api_hash"]),
        session_string=str(account["session_string"]),
        in_memory=True,
        no_updates=False,
        proxy=parse_proxy(account.get("proxy")),
    )


async def stop_client(client: Client) -> None:
    try:
        await client.stop()
    except Exception:
        pass
