from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
from datetime import datetime, timezone
from typing import Any

from runner.engine import Engine
from runner.github_mask import GitHubMasker
from runner.login import TelegramLoginRunner
from runner.models import TaskSpec
from runner.oidc import GitHubOIDCProvider
from runner.redaction import Redactor
from runner.worker_client import WorkerClient


def build_client() -> WorkerClient:
    worker_url = os.environ.get("WORKER_URL", "").strip()
    audience = os.environ.get("WORKER_OIDC_AUDIENCE", "").strip()
    if not worker_url or not audience:
        raise RuntimeError("WORKER_URL and WORKER_OIDC_AUDIENCE are required")
    return WorkerClient(worker_url, GitHubOIDCProvider(audience))


def task_run(args: argparse.Namespace) -> int:
    client = build_client()
    result: dict[str, Any]
    redactor = Redactor()
    try:
        claim = client.claim_task(args.run_id)
        GitHubMasker().add_mapping(claim)
        redactor = Redactor.from_mapping(claim)
        spec = TaskSpec.from_claim(claim, expected_run_id=args.run_id)
        result = Engine(client).run(spec)
    except Exception as exc:
        result = _failure(args.run_id, "runner_start_failed", redactor.text(exc))
        try:
            client.complete_task(args.run_id, result)
            result["callback_pending"] = False
        except Exception:
            result["callback_pending"] = True
    _write_result(args.result_file, result)
    return 0 if result.get("status") == "success" else 1


def task_finalize(args: argparse.Namespace) -> int:
    client = build_client()
    result = _read_result(args.result_file)
    if result is None:
        result = _failure(
            args.run_id,
            "runner_interrupted",
            "Runner exited before writing a result",
            ambiguous=True,
        )
    # The endpoint must be idempotent for the same run_id and terminal result.
    client.complete_task(args.run_id, result)
    result["callback_pending"] = False
    _write_result(args.result_file, result)
    return 0


def task_assert_success(args: argparse.Namespace) -> int:
    result = _read_result(args.result_file)
    if result is None:
        print("Task result is missing", file=sys.stderr)
        return 1
    if result.get("status") != "success":
        error = result.get("error") or {}
        print(
            f"Task failed: {error.get('code', 'unknown')} - {error.get('message', '')}",
            file=sys.stderr,
        )
        return 1
    return 0


def login_run(args: argparse.Namespace) -> int:
    client = build_client()
    try:
        result = TelegramLoginRunner(client).run(args.flow_id)
    except Exception as exc:
        result = {
            "flow_id": args.flow_id,
            "status": "failed",
            "error": {"code": "login_runner_failed", "message": str(exc)},
        }
        try:
            client.complete_login(args.flow_id, result)
        except Exception:
            pass
    # This result deliberately never contains the exported Session.
    _write_result(args.result_file, result)
    return 0 if result.get("status") == "connected" else 1


def login_finalize(args: argparse.Namespace) -> int:
    result = _read_result(args.result_file)
    if result is not None and result.get("status") == "connected":
        # The session-bearing completion already succeeded inside TelegramLoginRunner.
        return 0
    client = build_client()
    if result is None:
        result = {
            "flow_id": args.flow_id,
            "status": "failed",
            "error": {
                "code": "login_runner_interrupted",
                "message": "Login runner exited before writing a result",
            },
        }
    client.complete_login(args.flow_id, result)
    return 0


def _failure(
    run_id: str,
    code: str,
    message: str,
    *,
    ambiguous: bool = False,
) -> dict[str, Any]:
    now = datetime.now(timezone.utc).isoformat()
    return {
        "run_id": run_id,
        "status": "ambiguous" if ambiguous else "failed",
        "started_at": now,
        "finished_at": now,
        "duration_ms": 0,
        "attempts": 0,
        "error": {
            "code": code,
            "message": str(message),
            "retryable": False,
            "ambiguous": ambiguous,
        },
        "result": {},
        "logs": [],
    }


def _read_result(path: str) -> dict[str, Any] | None:
    try:
        value = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _write_result(path: str, result: dict[str, Any]) -> None:
    target = pathlib.Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".tmp")
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    descriptor = os.open(temporary, flags, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, separators=(",", ":"))
    try:
        temporary.chmod(0o600)
    except OSError:
        pass
    os.replace(temporary, target)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="Unified Telegram runner")
    commands = root.add_subparsers(dest="command", required=True)

    run = commands.add_parser("run")
    run.add_argument("--run-id", required=True)
    run.add_argument("--result-file", default=".runner-result.json")
    run.set_defaults(handler=task_run)

    finalize = commands.add_parser("finalize")
    finalize.add_argument("--run-id", required=True)
    finalize.add_argument("--result-file", default=".runner-result.json")
    finalize.set_defaults(handler=task_finalize)

    assertion = commands.add_parser("assert-success")
    assertion.add_argument("--result-file", default=".runner-result.json")
    assertion.set_defaults(handler=task_assert_success)

    login = commands.add_parser("login")
    login.add_argument("--flow-id", required=True)
    login.add_argument("--result-file", default=".login-result.json")
    login.set_defaults(handler=login_run)

    login_final = commands.add_parser("login-finalize")
    login_final.add_argument("--flow-id", required=True)
    login_final.add_argument("--result-file", default=".login-result.json")
    login_final.set_defaults(handler=login_finalize)
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    return int(args.handler(args))


if __name__ == "__main__":
    raise SystemExit(main())
