"""Shared log redaction for legacy notifications and migration tooling."""

from __future__ import annotations

import os
import re
import sys
from collections.abc import Iterable


REDACTED = "[REDACTED]"

_SECRET_ENV_NAMES = (
    "TG_SESSION_STRING",
    "TG_SESSION_STRING_2",
    "TG_API_HASH",
    "TG_API_HASH_2",
    "TG_PROXY",
    "TG_PROXY_2",
    "TG_SIGNER_IMPORT_BASE64",
    "TG_SIGNER_IMPORT_BASE64_2",
    "TELEGRAM_NOTIFY_BOT_TOKEN",
    "TELEGRAM_LOGIN_CODE",
    "TELEGRAM_2FA_PASSWORD",
    "TELEGRAM_PASSWORD",
    "GITHUB_TOKEN",
    "CLOUDFLARE_API_TOKEN",
)

_LABELLED_SECRET_RE = re.compile(
    r"(?im)^(?P<prefix>\s*(?:session(?:_string)?|tg_session_string|api[_-]?hash|"
    r"proxy(?:_password)?|verification[_-]?code|login[_-]?code|otp|"
    r"two[_-]?step[_-]?password|2fa[_-]?password|password)\s*[:=]\s*).+$"
)
_PROXY_CREDENTIALS_RE = re.compile(
    r"(?i)\b(?P<scheme>[a-z][a-z0-9+.-]*://)[^\s/@:]+:[^\s/@]+@"
)
_BOT_TOKEN_RE = re.compile(r"\b\d{6,12}:[A-Za-z0-9_-]{20,}\b")
_ACCESS_TOKEN_RE = re.compile(
    r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|"
    r"(?:sk|rk)-[A-Za-z0-9_-]{20,})\b"
)
_LONG_SECRET_RE = re.compile(r"(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{80,}={0,2}(?![A-Za-z0-9_-])")


def _environment_secrets() -> list[str]:
    return [os.getenv(name, "") for name in _SECRET_ENV_NAMES]


def redact_text(text: str, extra_secrets: Iterable[str] = ()) -> str:
    """Return text with exact known secrets and common secret shapes removed."""

    sanitized = str(text)
    secrets = {
        value
        for value in (*_environment_secrets(), *extra_secrets)
        if value and len(value) >= 4
    }
    for secret in sorted(secrets, key=len, reverse=True):
        sanitized = sanitized.replace(secret, REDACTED)

    sanitized = _LABELLED_SECRET_RE.sub(
        lambda match: f"{match.group('prefix')}{REDACTED}", sanitized
    )
    sanitized = _PROXY_CREDENTIALS_RE.sub(
        lambda match: f"{match.group('scheme')}{REDACTED}@", sanitized
    )
    sanitized = _BOT_TOKEN_RE.sub(REDACTED, sanitized)
    sanitized = _ACCESS_TOKEN_RE.sub(REDACTED, sanitized)
    sanitized = _LONG_SECRET_RE.sub(REDACTED, sanitized)
    return sanitized


def main() -> int:
    """Redact a subprocess stream before it reaches Actions logs or run.log."""

    for line in sys.stdin:
        sys.stdout.write(redact_text(line))
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
