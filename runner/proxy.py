from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any
from urllib.parse import urlparse


_ALLOWED_SCHEMES = frozenset({"http", "https", "socks4", "socks5", "socks5h"})
_INVALID_PROXY = "proxy configuration is invalid"


class ProxyConfigurationError(ValueError):
    """Raised without echoing a potentially credential-bearing proxy value."""


def decode_proxy(value: Any) -> dict[str, Any] | None:
    """Normalize legacy proxy URLs and D1 JSON objects for Kurigram.

    The Worker stores structured admin input as a JSON string, while legacy
    secrets contain a URL. Kurigram and tg-signer's ``UserSigner`` both expect
    the normalized Pyrogram mapping returned here.
    """

    if value is None or value == "":
        return None

    candidate: Any = value
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        if text.startswith("{"):
            try:
                candidate = json.loads(text)
            except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                raise ProxyConfigurationError(_INVALID_PROXY) from exc
        else:
            return _from_url(text)

    if isinstance(candidate, Mapping):
        return _from_mapping(candidate)
    raise ProxyConfigurationError(_INVALID_PROXY)


def _from_mapping(value: Mapping[str, Any]) -> dict[str, Any]:
    scheme = _required_text(value.get("scheme", value.get("protocol"))).lower()
    hostname = _required_text(value.get("hostname", value.get("host")))
    port = _port(value.get("port"))
    username = _optional_text(value.get("username"))
    password = _optional_text(value.get("password"))
    return _normalized(scheme, hostname, port, username, password)


def _from_url(value: str) -> dict[str, Any]:
    try:
        parsed = urlparse(value)
        port = parsed.port
    except (TypeError, ValueError) as exc:
        raise ProxyConfigurationError(_INVALID_PROXY) from exc
    if port is None:
        raise ProxyConfigurationError(_INVALID_PROXY)
    return _normalized(
        parsed.scheme.lower(),
        parsed.hostname,
        port,
        parsed.username,
        parsed.password,
    )


def _normalized(
    scheme: Any,
    hostname: Any,
    port: Any,
    username: Any,
    password: Any,
) -> dict[str, Any]:
    if scheme not in _ALLOWED_SCHEMES or not isinstance(hostname, str) or not hostname:
        raise ProxyConfigurationError(_INVALID_PROXY)
    return {
        "scheme": scheme,
        "hostname": hostname,
        "port": _port(port),
        "username": username,
        "password": password,
    }


def _required_text(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ProxyConfigurationError(_INVALID_PROXY)
    return value.strip()


def _optional_text(value: Any) -> str | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise ProxyConfigurationError(_INVALID_PROXY)
    return value


def _port(value: Any) -> int:
    if isinstance(value, bool):
        raise ProxyConfigurationError(_INVALID_PROXY)
    try:
        port = int(value)
    except (TypeError, ValueError) as exc:
        raise ProxyConfigurationError(_INVALID_PROXY) from exc
    if port < 1 or port > 65_535:
        raise ProxyConfigurationError(_INVALID_PROXY)
    return port
