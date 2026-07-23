from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


def message_time(message: Any) -> str:
    value = getattr(message, "date", None)
    if not isinstance(value, datetime):
        return ""
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def match_source(*, keyword_hit: bool, reply_hit: bool, keyword: str) -> str:
    sources: list[str] = []
    if keyword_hit and keyword:
        sources.append("消息文字")
    if reply_hit:
        sources.append("回复关系")
    if sources:
        return "、".join(sources)
    return "全部消息"


__all__ = ["match_source", "message_time"]
