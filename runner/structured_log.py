from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from typing import Any

from runner.redaction import Redactor


class StructuredLogger:
    def __init__(self, redactor: Redactor | None = None) -> None:
        self.redactor = redactor or Redactor()
        self.records: list[dict[str, Any]] = []

    def emit(self, level: str, event: str, **fields: Any) -> dict[str, Any]:
        record = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": level.lower(),
            "event": event,
            **fields,
        }
        sanitized = self.redactor.redact(record)
        self.records.append(sanitized)
        print(json.dumps(sanitized, ensure_ascii=False, separators=(",", ":")), flush=True)
        return sanitized

    def info(self, event: str, **fields: Any) -> dict[str, Any]:
        return self.emit("info", event, **fields)

    def warning(self, event: str, **fields: Any) -> dict[str, Any]:
        return self.emit("warning", event, **fields)

    def error(self, event: str, **fields: Any) -> dict[str, Any]:
        return self.emit("error", event, **fields)
