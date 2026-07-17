"""One-time, idempotent import of legacy GitHub Secrets into the D1 control plane."""

from __future__ import annotations

import argparse
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

try:
    from .redact import redact_text
except ImportError:  # Direct execution: python scripts/migrate_legacy.py
    from redact import redact_text


def _env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def _fallback(suffixed: str, primary: str, default: str = "") -> str:
    return _env(suffixed) or _env(primary, default)


def _optional_int(value: str) -> int | None:
    if not value:
        return None
    try:
        return int(value)
    except ValueError as exc:
        raise ValueError(f"Expected an integer legacy setting, got {value!r}") from exc


def _api_credentials(*, secondary: bool = False) -> dict[str, str]:
    """Materialize one complete pair without making credentials a prerequisite."""

    if secondary:
        api_id = _env("TG_API_ID_2")
        api_hash = _env("TG_API_HASH_2")
        if api_id and api_hash:
            return {"api_id": api_id, "api_hash": api_hash}
        # Never combine half of a secondary override with half of the primary pair.
        return _api_credentials()
    api_id = _env("TG_API_ID")
    api_hash = _env("TG_API_HASH")
    return {"api_id": api_id, "api_hash": api_hash} if api_id and api_hash else {}


def normalize_legacy_target(value: str) -> str:
    """Apply the exact peer-resolution compatibility rules used by the old shell."""

    target = str(value).strip().replace("\r", "").replace("\n", "")
    username = re.search(r"\busername:\s*([A-Za-z0-9_]+)", target)
    numeric_id = re.search(r"\bid:\s*(-?\d+)", target)
    if username:
        target = username.group(1)
    elif numeric_id:
        target = numeric_id.group(1)
    if target in {"8604751086", "freexzteam_bot", "@freexzteam_bot"}:
        return "@freexzteam_bot"
    if re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{4,31}", target):
        return "@" + target
    return target


def _task(
    *,
    suffix: str,
    account_legacy_id: str,
    mode: str,
    timezone: str,
) -> dict[str, Any]:
    is_secondary = suffix == "_2"
    target = (
        _fallback("TG_TARGET_CHAT_2", "TG_TARGET_CHAT")
        if is_secondary
        else _env("TG_TARGET_CHAT")
    )
    command = (
        _fallback("TG_CHECKIN_TEXT_2", "TG_CHECKIN_TEXT", "/checkin")
        if is_secondary
        else _env("TG_CHECKIN_TEXT", "/checkin")
    )
    signer_task = (
        _fallback("TG_SIGNER_TASK_NAME_2", "TG_SIGNER_TASK_NAME")
        if is_secondary
        else _env("TG_SIGNER_TASK_NAME")
    )
    signer_import = (
        _fallback("TG_SIGNER_IMPORT_BASE64_2", "TG_SIGNER_IMPORT_BASE64")
        if is_secondary
        else _env("TG_SIGNER_IMPORT_BASE64")
    )
    thread = (
        _fallback("TG_MESSAGE_THREAD_ID_2", "TG_MESSAGE_THREAD_ID")
        if is_secondary
        else _env("TG_MESSAGE_THREAD_ID")
    )
    delete_after = (
        _fallback("CHECKIN_DELETE_AFTER_2", "CHECKIN_DELETE_AFTER")
        if is_secondary
        else _env("CHECKIN_DELETE_AFTER")
    )

    normalized_mode = mode.replace("-", "_")
    skill = "tg_signer" if normalized_mode in {"task", "tg_signer"} else "send_text"
    return {
        "legacy_id": f"{account_legacy_id}-task",
        "account_legacy_id": account_legacy_id,
        "name": "旧配置签到（主账号）" if not is_secondary else "旧配置签到（第二账号）",
        "skill": skill,
        "target": normalize_legacy_target(target),
        "command": command,
        "signer_task_name": signer_task,
        "signer_import_base64": signer_import,
        "cron": "0 0 * * *",
        "timezone": timezone,
        "retry": 0,
        "timeout_seconds": 840,
        "thread": _optional_int(thread),
        "delete_after": _optional_int(delete_after),
        "enabled": True,
    }


def build_payload(*, dry_run: bool) -> dict[str, Any]:
    """Build an import document; dry-run documents contain no secret material."""

    primary_session = _env("TG_SESSION_STRING")
    secondary_session = _env("TG_SESSION_STRING_2")
    notification_token = _env("TELEGRAM_NOTIFY_BOT_TOKEN")
    notification_chat = _env("TELEGRAM_NOTIFY_CHAT_ID")
    mode = _env("SIGN_MODE", "send-text")
    timezone = _env("CHECKIN_TZ", "Asia/Shanghai")
    primary_credentials = _api_credentials()
    secondary_credentials = _api_credentials(secondary=True)

    common: dict[str, Any] = {
        "schema_version": 1,
        "dry_run": dry_run,
        "activate_scheduler": False,
        "source": {
            "repository": _env("GITHUB_REPOSITORY"),
            "ref": _env("GITHUB_REF"),
            "workflow": _env("GITHUB_WORKFLOW"),
            "run_id": _env("GITHUB_RUN_ID"),
        },
        "presence": {
            "primary_account": bool(primary_session),
            "secondary_account": bool(secondary_session),
            "primary_api_credentials": bool(primary_credentials),
            "secondary_api_credentials": bool(secondary_credentials),
            "notification": bool(notification_token and notification_chat),
            "signer_import": bool(
                _env("TG_SIGNER_IMPORT_BASE64")
                or _env("TG_SIGNER_IMPORT_BASE64_2")
            ),
            "proxy": bool(_env("TG_PROXY") or _env("TG_PROXY_2")),
        },
    }
    if dry_run:
        return common
    if not primary_session:
        raise ValueError("TG_SESSION_STRING is required for the legacy import")

    accounts: list[dict[str, Any]] = [
        {
            "legacy_id": "legacy-primary",
            "name": "旧主账号",
            "session_string": primary_session,
            **primary_credentials,
            "account": _env("TG_ACCOUNT"),
            "proxy": _env("TG_PROXY"),
            "enabled": True,
        }
    ]
    tasks = [
        _task(
            suffix="",
            account_legacy_id="legacy-primary",
            mode=mode,
            timezone=timezone,
        )
    ]
    if secondary_session:
        accounts.append(
            {
                "legacy_id": "legacy-secondary",
                "name": "旧第二账号",
                "session_string": secondary_session,
                **secondary_credentials,
                "account": _env("TG_ACCOUNT_2"),
                "proxy": _fallback("TG_PROXY_2", "TG_PROXY"),
                "enabled": True,
            }
        )
        tasks.append(
            _task(
                suffix="_2",
                account_legacy_id="legacy-secondary",
                mode=mode,
                timezone=timezone,
            )
        )

    return {
        **common,
        "accounts": accounts,
        "tasks": tasks,
        "notification": {
            "enabled": bool(notification_token and notification_chat),
            "bot_token": notification_token,
            "chat_id": notification_chat,
        },
    }


def request_oidc_token(audience: str) -> str:
    request_url = _env("ACTIONS_ID_TOKEN_REQUEST_URL")
    request_token = _env("ACTIONS_ID_TOKEN_REQUEST_TOKEN")
    if not request_url or not request_token:
        raise RuntimeError("GitHub OIDC environment is unavailable; grant id-token: write")
    separator = "&" if "?" in request_url else "?"
    url = f"{request_url}{separator}{urllib.parse.urlencode({'audience': audience})}"
    request = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {request_token}"},
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        document = json.load(response)
    token = str(document.get("value", ""))
    if not token:
        raise RuntimeError("GitHub OIDC response did not include a token")
    return token


def submit(payload: dict[str, Any]) -> dict[str, Any]:
    worker_url = (_env("WORKER_URL") or _env("CHECKIN_WORKER_URL")).rstrip("/")
    audience = (
        _env("WORKER_OIDC_AUDIENCE")
        or _env("CHECKIN_WORKER_AUDIENCE")
    )
    if not worker_url or not audience:
        raise RuntimeError("WORKER_URL and WORKER_OIDC_AUDIENCE are required")
    oidc_token = request_oidc_token(audience)
    request = urllib.request.Request(
        f"{worker_url}/api/runner/migrations/legacy",
        data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Bearer {oidc_token}",
            "Content-Type": "application/json",
            "Idempotency-Key": f"legacy-{_env('GITHUB_RUN_ID', 'manual')}",
            "User-Agent": "telegram-checkin-legacy-migrator/1",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        safe_body = redact_text(exc.read(1024).decode("utf-8", errors="replace"))
        raise RuntimeError(f"Worker rejected migration (HTTP {exc.code}): {safe_body}") from None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Transmit the legacy values. Without this flag only presence metadata is sent.",
    )
    args = parser.parse_args()
    payload = build_payload(dry_run=not args.apply)
    result = submit(payload)
    print(
        json.dumps(
            {
                "ok": bool(result.get("ok", True)),
                "dry_run": payload["dry_run"],
                "accounts_planned": int(result.get("accounts_planned", len(payload.get("accounts", [])))),
                "tasks_planned": int(result.get("tasks_planned", len(payload.get("tasks", [])))),
                "scheduler_activated": False,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
