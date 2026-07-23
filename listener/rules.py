from __future__ import annotations

import json
from typing import Any
from urllib.parse import urlparse

GROUP_TYPES = {"group", "supergroup", "channel"}
BUTTON_PRIORITY = ("签到", "打卡", "领取", "check in", "checkin", "sign")
REPLY_TRIGGER_MODES = {"keyword", "reply_to_own", "keyword_or_reply_to_own"}


def parse_proxy(value: str | None) -> dict[str, Any] | None:
    if not value:
        return None
    parsed = urlparse(value)
    if not parsed.scheme or not parsed.hostname or not parsed.port:
        return None
    return {
        "scheme": parsed.scheme,
        "hostname": parsed.hostname,
        "port": parsed.port,
        "username": parsed.username,
        "password": parsed.password,
    }


def chat_type_name(chat: Any) -> str:
    value = getattr(chat, "type", "")
    return str(getattr(value, "value", value)).split(".")[-1].lower()


def message_text(message: Any) -> str:
    return str(getattr(message, "text", None) or getattr(message, "caption", None) or "")


def is_own_message(message: Any) -> bool:
    if message is None:
        return False
    if bool(getattr(message, "outgoing", False)):
        return True
    sender = getattr(message, "from_user", None)
    return bool(sender is not None and getattr(sender, "is_self", False))


def replies_to_own_message(message: Any) -> bool:
    return is_own_message(getattr(message, "reply_to_message", None))


def trigger_matches(mode: str, *, keyword_match: bool, reply_to_own: bool) -> bool:
    normalized = mode if mode in REPLY_TRIGGER_MODES else "keyword"
    if normalized == "reply_to_own":
        return reply_to_own
    if normalized == "keyword_or_reply_to_own":
        return keyword_match or reply_to_own
    return keyword_match


def message_buttons(message: Any) -> list[str]:
    markup = getattr(message, "reply_markup", None)
    rows = getattr(markup, "inline_keyboard", None) or []
    output: list[str] = []
    for row in rows:
        for button in row:
            label = str(getattr(button, "text", "") or "").strip()
            if label and label not in output:
                output.append(label)
    return output


def parse_selectors(selector: str | list[str] | tuple[str, ...] | None) -> tuple[str, ...]:
    if isinstance(selector, (list, tuple)):
        raw_values = list(selector)
    else:
        source = str(selector or "").strip()
        if not source:
            return tuple()
        raw_values: list[Any]
        if source.startswith("["):
            try:
                parsed = json.loads(source)
                raw_values = parsed if isinstance(parsed, list) else [source]
            except (TypeError, ValueError, json.JSONDecodeError):
                raw_values = source.replace("\n", ",").split(",")
        else:
            raw_values = source.replace("\n", ",").split(",")

    values: list[str] = []
    seen: set[str] = set()
    for raw_value in raw_values:
        value = str(raw_value or "").strip()
        if not value:
            continue
        key = value.casefold() if value.startswith("@") else value
        if key in seen:
            continue
        seen.add(key)
        values.append(value)
    return tuple(values)


def _single_selector_matches(selector: str, message: Any) -> bool:
    if selector == "*":
        return True
    chat = getattr(message, "chat", None)
    if not chat:
        return False
    if selector.startswith("@"):
        return str(getattr(chat, "username", "") or "").casefold() == selector[1:].casefold()
    return str(getattr(chat, "id", "")) == selector


def selector_matches(selector: str | list[str] | tuple[str, ...], message: Any) -> bool:
    selectors = parse_selectors(selector)
    return any(_single_selector_matches(value, message) for value in selectors)


def keyword_matches(keyword: str, value: str, *, case_sensitive: bool) -> bool:
    if not keyword:
        return True
    if case_sensitive:
        return keyword in value
    return keyword.casefold() in value.casefold()


def suggested_button(buttons: list[str]) -> str | None:
    for marker in BUTTON_PRIORITY:
        for button in buttons:
            if marker.casefold() in button.casefold():
                return button
    return buttons[0] if buttons else None
