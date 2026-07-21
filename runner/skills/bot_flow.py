from __future__ import annotations

import asyncio
import time
from collections.abc import Mapping
from typing import Any

from runner.skills.base import (
    Skill,
    SkillContext,
    SkillError,
    SkillResult,
    SkillValidationError,
    optional_int,
    required_text,
)
from runner.skills.telegram_adapter import (
    build_signer,
    classify_telegram_exception,
    telegram_environment,
)
from runner.skills.telegram_primitives import (
    button_candidates,
    click_safe_callback,
    latest_message_id,
    message_id,
    message_text,
    normalize_target,
    select_button,
    wait_for_message,
)
from runner.workspace import SecretWorkspace

_ALLOWED_ACTIONS = frozenset({"send", "wait_message", "read_buttons", "click_button"})
_MAX_STEPS = 20
_MAX_TOTAL_TIMEOUT = 600


class BotFlowSkill(Skill):
    name = "bot_flow"

    def validate(self, params: Mapping[str, Any]) -> dict[str, Any]:
        target = normalize_target(params.get("target"))
        raw_steps = params.get("steps")
        if not isinstance(raw_steps, list) or not raw_steps:
            raise SkillValidationError("steps must be a non-empty list")
        if len(raw_steps) > _MAX_STEPS:
            raise SkillValidationError(f"steps cannot contain more than {_MAX_STEPS} items")

        steps: list[dict[str, Any]] = []
        total_timeout = 0
        for index, raw_step in enumerate(raw_steps):
            field = f"steps[{index}]"
            if not isinstance(raw_step, Mapping):
                raise SkillValidationError(f"{field} must be an object")
            action = required_text(raw_step.get("action"), f"{field}.action", maximum=40)
            if action not in _ALLOWED_ACTIONS:
                raise SkillValidationError(f"{field}.action is not supported")
            allowed_fields = {
                "send": {"action", "text", "timeout"},
                "wait_message": {"action", "match", "match_any", "timeout"},
                "read_buttons": {"action", "timeout"},
                "click_button": {"action", "button", "timeout"},
            }[action]
            unknown = set(raw_step) - allowed_fields
            if unknown:
                raise SkillValidationError(f"{field} contains unsupported fields")
            timeout = optional_int(raw_step.get("timeout"), f"{field}.timeout", minimum=1, maximum=120)
            if timeout is None:
                raise SkillValidationError(f"{field}.timeout is required")
            total_timeout += timeout
            step: dict[str, Any] = {"action": action, "timeout": timeout}
            if action == "send":
                step["text"] = required_text(raw_step.get("text"), f"{field}.text", maximum=4000)
            elif action == "wait_message":
                match = str(raw_step.get("match") or "").strip()
                raw_any = raw_step.get("match_any") or []
                if not isinstance(raw_any, list):
                    raise SkillValidationError(f"{field}.match_any must be a list")
                match_any = []
                for item in raw_any:
                    value = str(item).strip()
                    if not value or len(value) > 200:
                        raise SkillValidationError(f"{field}.match_any contains an invalid keyword")
                    match_any.append(value)
                if len(match) > 200:
                    raise SkillValidationError(f"{field}.match is too long")
                if not match and not match_any:
                    raise SkillValidationError(f"{field} requires match or match_any")
                if len(match_any) > 20:
                    raise SkillValidationError(f"{field}.match_any cannot contain more than 20 items")
                step["match"] = match or None
                step["match_any"] = match_any
            elif action == "click_button":
                step["button"] = required_text(raw_step.get("button"), f"{field}.button", maximum=128)
            steps.append(step)

        if total_timeout > _MAX_TOTAL_TIMEOUT:
            raise SkillValidationError(
                f"combined step timeout cannot exceed {_MAX_TOTAL_TIMEOUT} seconds"
            )
        return {
            "target": target,
            "steps": steps,
            "message_thread_id": optional_int(
                params.get("message_thread_id"), "message_thread_id", minimum=1
            ),
        }

    async def _execute_flow(self, signer: Any, values: dict[str, Any]) -> SkillResult:
        await signer.login(num_of_dialogs=1, print_chat=False)
        target = values["target"]
        logs: list[dict[str, Any]] = []
        side_effect = False
        last_message: Any | None = None
        async with signer.app:
            cursor = await latest_message_id(signer.app, target)
            for index, step in enumerate(values["steps"], start=1):
                started = time.monotonic()
                action = step["action"]
                record: dict[str, Any] = {
                    "level": "info",
                    "event": "bot_flow_step",
                    "step": index,
                    "action": action,
                    "status": "running",
                }
                try:
                    async with asyncio.timeout(step["timeout"]):
                        if action == "send":
                            sent = await signer.send_message(
                                target,
                                step["text"],
                                message_thread_id=values["message_thread_id"],
                            )
                            cursor = max(cursor, message_id(sent))
                            last_message = sent
                            side_effect = True
                            record.update({"message_id": message_id(sent)})
                        elif action == "wait_message":
                            last_message, cursor = await wait_for_message(
                                signer.app,
                                target,
                                after_id=cursor,
                                timeout=step["timeout"],
                                match=step["match"],
                                match_any=step["match_any"],
                            )
                            record.update({
                                "message_id": message_id(last_message),
                                "matched_text": message_text(last_message)[:240],
                            })
                        elif action == "read_buttons":
                            if last_message is None or not button_candidates(last_message):
                                last_message, cursor = await wait_for_message(
                                    signer.app,
                                    target,
                                    after_id=cursor,
                                    timeout=step["timeout"],
                                    require_buttons=True,
                                )
                            record.update({
                                "message_id": message_id(last_message),
                                "buttons": [item.text for item in button_candidates(last_message)][:40],
                            })
                        elif action == "click_button":
                            requested = step["button"]
                            if last_message is None or select_button(last_message, requested) is None:
                                last_message, cursor = await wait_for_message(
                                    signer.app,
                                    target,
                                    after_id=cursor,
                                    timeout=step["timeout"],
                                    require_buttons=True,
                                )
                            clicked = await click_safe_callback(last_message, requested)
                            side_effect = True
                            record.update({
                                "message_id": message_id(last_message),
                                "button": clicked,
                            })
                    record["status"] = "success"
                    record["duration_ms"] = round((time.monotonic() - started) * 1000)
                    logs.append(record)
                except TimeoutError as exc:
                    record["status"] = "ambiguous" if side_effect else "failed"
                    record["error_code"] = "bot_flow_step_timeout"
                    record["duration_ms"] = round((time.monotonic() - started) * 1000)
                    logs.append(record)
                    raise SkillError(
                        f"第 {index} 步执行超时。",
                        code="bot_flow_step_timeout",
                        retryable=False,
                        ambiguous=side_effect,
                        logs=logs,
                    ) from exc
                except SkillError as exc:
                    record["status"] = "ambiguous" if side_effect and exc.code in {
                        "telegram_wait_timeout", "telegram_button_not_found"
                    } else "failed"
                    record["error_code"] = exc.code
                    record["duration_ms"] = round((time.monotonic() - started) * 1000)
                    logs.append(record)
                    raise SkillError(
                        str(exc),
                        code=exc.code,
                        retryable=False,
                        ambiguous=record["status"] == "ambiguous",
                        logs=logs,
                    ) from exc
                except Exception as exc:
                    classified = classify_telegram_exception(exc)
                    ambiguous = classified.ambiguous or (
                        side_effect and classified.code == "telegram_transport"
                    )
                    record["status"] = "ambiguous" if ambiguous else "failed"
                    record["error_code"] = classified.code
                    record["duration_ms"] = round((time.monotonic() - started) * 1000)
                    logs.append(record)
                    raise SkillError(
                        str(classified),
                        code=classified.code,
                        retryable=classified.retryable and not ambiguous,
                        ambiguous=ambiguous,
                        retry_after_seconds=classified.retry_after_seconds,
                        logs=logs,
                    ) from exc
        return SkillResult(
            data={
                "completed": True,
                "steps_completed": len(values["steps"]),
                "last_message_id": message_id(last_message) if last_message is not None else None,
                "last_message": message_text(last_message)[:500] if last_message is not None else None,
            },
            logs=logs,
        )

    def execute(self, context: SkillContext, params: Mapping[str, Any]) -> SkillResult:
        values = self.validate(params)
        try:
            with SecretWorkspace(prefix="telegram-bot-flow-") as workspace:
                with telegram_environment(context.secrets):
                    signer = build_signer(context, task_name=None, workspace=workspace)
                    return signer.loop.run_until_complete(self._execute_flow(signer, values))
        except Exception as exc:
            if isinstance(exc, (SkillError, SkillValidationError)):
                raise
            raise classify_telegram_exception(exc) from exc


__test__ = {
    "allowed_actions": _ALLOWED_ACTIONS,
    "max_steps": _MAX_STEPS,
    "max_total_timeout": _MAX_TOTAL_TIMEOUT,
}
