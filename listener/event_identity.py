from __future__ import annotations

from typing import Any


CHAT_TYPE_LABELS = {
    "private": "私聊",
    "group": "群组",
    "supergroup": "超级群组",
    "channel": "频道",
}


def _text(value: Any) -> str:
    return str(value or "").strip()


def _username(value: Any) -> str:
    return _text(value).lstrip("@")


def _full_name(value: Any) -> str:
    return " ".join(
        part
        for part in (
            _text(getattr(value, "first_name", "")),
            _text(getattr(value, "last_name", "")),
        )
        if part
    )


def _chat_type(value: Any) -> str:
    raw = getattr(value, "type", "")
    enum_value = getattr(raw, "value", raw)
    return _text(enum_value).lower()


def _label(name: str, username: str) -> str:
    if name and username:
        return f"{name}（@{username}）"
    if name:
        return name
    if username:
        return f"@{username}"
    return ""


def chat_identity(chat: Any) -> dict[str, str]:
    chat_id = _text(getattr(chat, "id", ""))
    chat_type = _chat_type(chat)
    username = _username(getattr(chat, "username", ""))
    title = _text(getattr(chat, "title", ""))
    name = title or _full_name(chat)
    label = _label(name, username)
    if not label:
        type_label = CHAT_TYPE_LABELS.get(chat_type, "会话")
        label = f"{type_label}（名称未公开）" if chat_id else "未知会话"
    return {
        "chat_id": chat_id,
        "chat_title": name[:160],
        "chat_username": username[:64],
        "chat_type": chat_type[:32],
        "chat_label": label[:220],
    }


def sender_identity(message: Any) -> dict[str, str]:
    sender = getattr(message, "from_user", None)
    if sender is not None:
        sender_id = _text(getattr(sender, "id", ""))
        username = _username(getattr(sender, "username", ""))
        name = _full_name(sender)
        sender_type = "bot" if bool(getattr(sender, "is_bot", False)) else "user"
        label = _label(name, username)
        if not label:
            label = "Telegram 机器人（名称未公开）" if sender_type == "bot" else "Telegram 用户（名称未公开）"
        return {
            "sender_id": sender_id,
            "sender_name": name[:160],
            "sender_username": username[:64],
            "sender_type": sender_type,
            "sender_label": label[:220],
        }

    sender_chat = getattr(message, "sender_chat", None)
    if sender_chat is not None:
        chat = chat_identity(sender_chat)
        sender_type = "anonymous_admin" if _chat_type(sender_chat) in {"group", "supergroup"} else "chat_identity"
        prefix = "匿名管理员" if sender_type == "anonymous_admin" else "以会话身份发送"
        return {
            "sender_id": chat["chat_id"],
            "sender_name": chat["chat_title"],
            "sender_username": chat["chat_username"],
            "sender_type": sender_type,
            "sender_label": f"{prefix}：{chat['chat_label']}"[:220],
        }

    author_signature = _text(getattr(message, "author_signature", ""))
    return {
        "sender_id": "",
        "sender_name": author_signature[:160],
        "sender_username": "",
        "sender_type": "channel_signature" if author_signature else "unknown",
        "sender_label": (f"频道签名：{author_signature}" if author_signature else "发送者身份未公开")[:220],
    }


def message_source(message: Any) -> dict[str, str]:
    chat = chat_identity(getattr(message, "chat", None))
    sender = sender_identity(message)
    link = _text(getattr(message, "link", ""))
    if link and not link.startswith(("https://t.me/", "http://t.me/")):
        link = ""
    return {
        **chat,
        **sender,
        "message_link": link[:500],
    }
