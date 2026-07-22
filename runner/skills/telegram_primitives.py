from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from datetime import timezone
from typing import Any, Iterable

from runner.skills.base import SkillError, SkillValidationError, required_text


@dataclass(frozen=True, slots=True)
class TelegramButton:
    text: str
    safe_callback: bool


def normalize_target(value: Any) -> str | int:
    raw = required_text(value, "target", maximum=128)
    username_match = re.search(r"\busername:\s*([A-Za-z0-9_]+)", raw)
    id_match = re.search(r"\bid:\s*(-?\d+)", raw)
    if username_match:
        raw = username_match.group(1)
    elif id_match:
        raw = id_match.group(1)
    if raw in {"8604751086", "freexzteam_bot", "@freexzteam_bot"}:
        raw = "@freexzteam_bot"
    if raw.casefold() in {"me", "self"}:
        return "me"
    if raw.startswith("@"):
        if not re.fullmatch(r"@[A-Za-z][A-Za-z0-9_]{4,31}", raw):
            raise SkillValidationError("target must be @username or a numeric chat id")
        return raw
    if re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{4,31}", raw):
        return "@" + raw
    try:
        return int(raw)
    except ValueError as exc:
        raise SkillValidationError("target must be @username or a numeric chat id") from exc


def message_text(message: Any) -> str:
    return str(getattr(message, "text", None) or getattr(message, "caption", None) or "")


def message_id(message: Any) -> int:
    return int(getattr(message, "id", 0) or 0)


def message_time(message: Any) -> str | None:
    value = getattr(message, "date", None)
    if value is None:
        return None
    try:
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).isoformat()
    except (AttributeError, ValueError):
        return str(value)


def sender_label(message: Any) -> str:
    sender = getattr(message, "from_user", None)
    if sender is not None:
        username = str(getattr(sender, "username", "") or "").strip().lstrip("@")
        if username:
            return f"@{username}"
        name = " ".join(
            value
            for value in (
                str(getattr(sender, "first_name", "") or "").strip(),
                str(getattr(sender, "last_name", "") or "").strip(),
            )
            if value
        )
        if name:
            return name
        identifier = getattr(sender, "id", None)
        if identifier is not None:
            return str(identifier)
    sender_chat = getattr(message, "sender_chat", None)
    if sender_chat is not None:
        username = str(getattr(sender_chat, "username", "") or "").strip().lstrip("@")
        if username:
            return f"@{username}"
        title = str(getattr(sender_chat, "title", "") or "").strip()
        if title:
            return title
        identifier = getattr(sender_chat, "id", None)
        if identifier is not None:
            return str(identifier)
    return "unknown"


def button_candidates(message: Any) -> list[TelegramButton]:
    markup = getattr(message, "reply_markup", None)
    rows = getattr(markup, "inline_keyboard", None) or []
    values: list[TelegramButton] = []
    for row in rows:
        for button in row:
            text = str(getattr(button, "text", "") or "").strip()
            if not text:
                continue
            callback_data = getattr(button, "callback_data", None)
            unsafe_markers = (
                getattr(button, "url", None),
                getattr(button, "login_url", None),
                getattr(button, "web_app", None),
                getattr(button, "switch_inline_query", None),
                getattr(button, "switch_inline_query_current_chat", None),
                getattr(button, "callback_game", None),
                getattr(button, "pay", None),
            )
            values.append(
                TelegramButton(
                    text=text,
                    safe_callback=callback_data is not None and not any(unsafe_markers),
                )
            )
    return values


def button_texts(message: Any) -> list[str]:
    return [value.text for value in button_candidates(message)]


def contains_any(text: str, keywords: Iterable[str]) -> bool:
    normalized = text.casefold()
    return any(str(keyword).casefold() in normalized for keyword in keywords)


def message_matches(message: Any, *, match: str | None = None, match_any: Iterable[str] = ()) -> bool:
    text = message_text(message)
    if match is not None and str(match).casefold() not in text.casefold():
        return False
    values = [str(value) for value in match_any if str(value)]
    if values and not contains_any(text, values):
        return False
    return match is not None or bool(values)


async def latest_message_id(app: Any, target: str | int) -> int:
    async for message in app.get_chat_history(target, limit=1):
        return message_id(message)
    return 0


async def recent_messages(app: Any, target: str | int, after_id: int, *, limit: int = 50) -> list[Any]:
    messages: list[Any] = []
    async for message in app.get_chat_history(target, limit=limit):
        current = message_id(message)
        if current <= after_id:
            break
        messages.append(message)
    messages.reverse()
    return messages


async def wait_for_message(
    app: Any,
    target: str | int,
    *,
    after_id: int,
    timeout: int,
    match: str | None = None,
    match_any: Iterable[str] = (),
    require_buttons: bool = False,
) -> tuple[Any, int]:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    cursor = after_id
    while loop.time() < deadline:
        for message in await recent_messages(app, target, cursor):
            cursor = max(cursor, message_id(message))
            if getattr(message, "outgoing", False):
                continue
            if require_buttons and not button_candidates(message):
                continue
            if match is None and not tuple(match_any):
                return message, cursor
            if message_matches(message, match=match, match_any=match_any):
                return message, cursor
        await asyncio.sleep(1)
    raise SkillError(
        "等待 Telegram 回复超时。",
        code="telegram_wait_timeout",
        retryable=False,
        ambiguous=False,
    )


def select_button(message: Any, requested: str) -> TelegramButton | None:
    requested_folded = requested.casefold()
    candidates = button_candidates(message)
    for candidate in candidates:
        if candidate.text.casefold() == requested_folded:
            return candidate
    for candidate in candidates:
        if requested_folded in candidate.text.casefold():
            return candidate
    return None


async def click_safe_callback(message: Any, requested: str) -> str:
    candidate = select_button(message, requested)
    if candidate is None:
        raise SkillError(
            f"没有找到按钮：{requested}",
            code="telegram_button_not_found",
            retryable=False,
            ambiguous=False,
        )
    if not candidate.safe_callback:
        raise SkillError(
            f"按钮不是允许自动点击的 Callback 按钮：{candidate.text}",
            code="unsafe_telegram_button",
            retryable=False,
            ambiguous=False,
        )
    await message.click(candidate.text)
    return candidate.text
