from __future__ import annotations

import time
from collections import deque
from typing import Any, Callable

REPLY_COOLDOWN_SECONDS = 60
REPLIES_PER_RULE_PER_HOUR = 60


def is_human_sender(sender: Any) -> bool:
    """Only real Telegram users may trigger realtime monitoring or replies."""
    return sender is not None and not bool(getattr(sender, "is_bot", False))


class ReplyLimiter:
    def __init__(self, monotonic: Callable[[], float] = time.monotonic) -> None:
        self._monotonic = monotonic
        self._cooldowns: dict[tuple[str, str, str], float] = {}
        self._windows: dict[str, deque[float]] = {}

    def allow(self, rule_id: str, chat_id: str, sender_id: str) -> bool:
        now = self._monotonic()
        key = (rule_id, chat_id, sender_id)
        prior = self._cooldowns.get(key)
        if prior is not None and now - prior < REPLY_COOLDOWN_SECONDS:
            return False

        window = self._windows.setdefault(rule_id, deque())
        while window and now - window[0] >= 3_600:
            window.popleft()
        if len(window) >= REPLIES_PER_RULE_PER_HOUR:
            return False

        self._cooldowns[key] = now
        window.append(now)
        if len(self._cooldowns) > 20_000:
            cutoff = now - 3_600
            self._cooldowns = {
                item: timestamp
                for item, timestamp in self._cooldowns.items()
                if timestamp >= cutoff
            }
        return True
