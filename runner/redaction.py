from __future__ import annotations

import json
import re
from collections.abc import Mapping
from typing import Any, Iterable
from urllib.parse import unquote, urlparse


REDACTED = "***"
_SENSITIVE_KEY = re.compile(
    r"(?:session|api[_-]?(?:id|hash)|password|passphrase|(?:^|[_-])phone(?:$|[_-])|phone[_-]?code|"
    r"verification[_-]?code|two[_-]?factor|2fa|token|secret|import[_-]?(?:blob|config))",
    re.IGNORECASE,
)
_PROXY_CREDENTIAL = re.compile(
    r"(?P<prefix>\b(?:https?|socks5h?|mtproto)://[^\s:/@]+:)[^\s@]+(?P<suffix>@)",
    re.IGNORECASE,
)
_KEY_VALUE = re.compile(
    r"(?P<key>session(?:_string)?|api[_-]?hash|password|phone[_-]?code|"
    r"verification[_-]?code|two[_-]?factor|2fa|token)"
    r"(?P<separator>\s*[:=]\s*)(?P<value>[^\s,;]+)",
    re.IGNORECASE,
)


def sensitive_values_from_mapping(value: Mapping[str, Any]) -> tuple[str, ...]:
    """Return dynamic values that must be masked before untrusted code runs."""

    secrets: set[str] = set()

    def add(current: Any) -> None:
        if current is None or current == "":
            return
        if isinstance(current, Mapping):
            try:
                secrets.add(json.dumps(current, ensure_ascii=False, separators=(",", ":")))
                secrets.add(json.dumps(current, ensure_ascii=False, separators=(",", ":"), sort_keys=True))
            except (TypeError, ValueError):
                pass
            secrets.add(str(dict(current)))
            return
        secrets.add(str(current))

    def collect_all(current: Any, key: str = "") -> None:
        if isinstance(current, Mapping):
            add(current)
            for child_key, child_value in current.items():
                collect_all(child_value, str(child_key))
        elif isinstance(current, (list, tuple)):
            for child in current:
                collect_all(child, key)
        else:
            add(current)

    def collect_proxy(current: Any) -> None:
        add(current)
        if isinstance(current, Mapping):
            for child_key in ("host", "hostname", "username", "password"):
                add(current.get(child_key))
            return
        if not isinstance(current, str):
            return
        try:
            decoded = json.loads(current)
        except (json.JSONDecodeError, TypeError, ValueError):
            decoded = None
        if isinstance(decoded, Mapping):
            collect_proxy(decoded)
        parsed = urlparse(current)
        for part in (parsed.hostname, parsed.username, parsed.password):
            add(part)
            if part:
                add(unquote(part))

    def collect(current: Any, key: str = "") -> None:
        if key.lower() == "proxy":
            collect_proxy(current)
        elif _SENSITIVE_KEY.search(key):
            collect_all(current, key)
        elif isinstance(current, Mapping):
            for child_key, child_value in current.items():
                collect(child_value, str(child_key))
        elif isinstance(current, (list, tuple)):
            for child in current:
                collect(child, key)

    collect(value)
    return tuple(sorted(secrets, key=len, reverse=True))


class Redactor:
    def __init__(self, secrets: Iterable[Any] = ()) -> None:
        values = {
            str(value)
            for value in secrets
            if value is not None and str(value) != ""
        }
        self._secrets = tuple(
            sorted((value for value in values if len(value) >= 3), key=len, reverse=True)
        )
        self._short_secrets = tuple(
            sorted((value for value in values if len(value) < 3), key=len, reverse=True)
        )

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "Redactor":
        return cls(sensitive_values_from_mapping(value))

    def text(self, value: Any) -> str:
        result = str(value)
        for secret in self._secrets:
            result = result.replace(secret, REDACTED)
        for secret in self._short_secrets:
            result = re.sub(
                rf"(?<![A-Za-z0-9]){re.escape(secret)}(?![A-Za-z0-9])",
                REDACTED,
                result,
            )
        result = _PROXY_CREDENTIAL.sub(
            lambda match: match.group("prefix") + REDACTED + match.group("suffix"),
            result,
        )
        result = _KEY_VALUE.sub(
            lambda match: match.group("key")
            + match.group("separator")
            + REDACTED,
            result,
        )
        return result

    def redact(self, value: Any, *, key: str = "") -> Any:
        if _SENSITIVE_KEY.search(key):
            return REDACTED
        if isinstance(value, Mapping):
            return {
                str(child_key): self.redact(child_value, key=str(child_key))
                for child_key, child_value in value.items()
            }
        if isinstance(value, list):
            return [self.redact(item, key=key) for item in value]
        if isinstance(value, tuple):
            return tuple(self.redact(item, key=key) for item in value)
        if isinstance(value, str):
            return self.text(value)
        return value
