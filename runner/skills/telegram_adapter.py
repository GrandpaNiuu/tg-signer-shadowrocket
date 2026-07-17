from __future__ import annotations

import contextlib
import os
from collections.abc import Iterator, Mapping
from typing import Any

from runner.proxy import decode_proxy
from runner.skills.base import SkillError
from runner.workspace import SecretWorkspace


@contextlib.contextmanager
def telegram_environment(secrets: Mapping[str, Any]) -> Iterator[None]:
    """Set library-only credentials in the isolated child, then remove them."""

    names = {"TG_API_ID": secrets.get("api_id"), "TG_API_HASH": secrets.get("api_hash")}
    before = {name: os.environ.get(name) for name in names}
    old_umask = os.umask(0o077)
    try:
        for name, value in names.items():
            if value not in (None, ""):
                os.environ[name] = str(value)
        yield
    finally:
        os.umask(old_umask)
        for name, value in before.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


def load_tg_signer():
    try:
        from tg_signer.core import UserSigner
    except ImportError as exc:
        raise SkillError(
            "tg-signer dependency is not installed",
            code="dependency_missing",
            retryable=False,
        ) from exc
    return UserSigner


def build_signer(context, *, task_name: str | None, workspace: SecretWorkspace):
    UserSigner = load_tg_signer()
    session_string = str(context.secrets.get("session_string", ""))
    if not session_string:
        raise SkillError("Telegram session is missing", code="session_missing")
    proxy_value = context.secrets.get("proxy")
    proxy = decode_proxy(proxy_value)
    account = "account_" + "".join(
        character if character.isalnum() else "_" for character in context.account_id
    )[:48]
    return UserSigner(
        task_name=task_name,
        account=account,
        proxy=proxy,
        session_dir=str(workspace.path),
        workdir=str(workspace.path / "signer"),
        session_string=session_string,
        in_memory=True,
    )


def classify_telegram_exception(exc: BaseException) -> SkillError:
    name = type(exc).__name__
    message = str(exc) or name
    lowered = name.lower() + " " + message.lower()
    if any(value in lowered for value in ("unauthorized", "authkey", "sessionrevoked")):
        return SkillError(message, code="session_invalid", retryable=False)
    if "floodwait" in lowered or "flood_wait" in lowered:
        wait_value = getattr(exc, "value", getattr(exc, "x", 1))
        try:
            retry_after = min(max(int(wait_value), 1), 900)
        except (TypeError, ValueError):
            retry_after = 1
        # Telegram rejected the request with a wait instruction before executing it.
        return SkillError(
            message,
            code="flood_wait",
            retryable=True,
            ambiguous=False,
            retry_after_seconds=retry_after,
        )
    if any(value in lowered for value in ("timeout", "network", "connection")):
        # Telegram failures raised by the skill may occur after a message was accepted.
        return SkillError(message, code="telegram_transport", retryable=True, ambiguous=True)
    return SkillError(message, code="telegram_error", retryable=False)
