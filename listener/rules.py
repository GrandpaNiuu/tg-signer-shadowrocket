from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

GROUP_TYPES = {"group", "supergroup", "channel"}
BUTTON_PRIORITY = ("签到", "打卡", "领取", "check in", "checkin", "sign")


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


def selector_matches(selector: str, message: Any) -> bool:
    if selector == "*":
        return True
    chat = getattr(message, "chat", None)
    if not chat:
        return False
    if selector.startswith("@"):
        return str(getattr(chat, "username", "") or "").casefold() == selector[1:].casefold()
    return str(getattr(chat, "id", "")) == selector


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
