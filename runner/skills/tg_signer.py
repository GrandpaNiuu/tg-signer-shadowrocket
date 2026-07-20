from __future__ import annotations

import asyncio
import base64
import binascii
import json
import re
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
from runner.workspace import SecretWorkspace

_GUIDED_FLOW_KIND = "telegram_guided_signin"
_GUIDED_FLOW_VERSION = 1


def _target(value: Any) -> str | int:
    raw = required_text(value, "target", maximum=128)
    username_match = re.search(r"\busername:\s*([A-Za-z0-9_]+)", raw)
    id_match = re.search(r"\bid:\s*(-?\d+)", raw)
    if username_match:
        raw = username_match.group(1)
    elif id_match:
        raw = id_match.group(1)
    if raw.startswith("@"):
        return raw
    if re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{4,31}", raw):
        return "@" + raw
    try:
        return int(raw)
    except ValueError as exc:
        raise SkillValidationError("target must be @username or a numeric chat id") from exc


def _message_text(message: Any) -> str:
    return str(getattr(message, "text", None) or getattr(message, "caption", None) or "")


def _button_texts(message: Any) -> list[str]:
    markup = getattr(message, "reply_markup", None)
    rows = getattr(markup, "inline_keyboard", None)
    if not rows:
        return []
    values: list[str] = []
    for row in rows:
        for button in row:
            text = str(getattr(button, "text", "") or "").strip()
            if text:
                values.append(text)
    return values


def _contains_any(text: str, keywords: list[str]) -> bool:
    normalized = text.casefold()
    return any(keyword.casefold() in normalized for keyword in keywords)


class TgSignerSkill(Skill):
    name = "tg_signer"

    def validate(self, params: Mapping[str, Any]) -> dict[str, Any]:
        return {
            "task_name": required_text(params.get("task_name"), "task_name", maximum=128),
            "import_blob": params.get("import_blob"),
            "import_encoding": str(params.get("import_encoding", "auto")),
            "num_of_dialogs": optional_int(
                params.get("num_of_dialogs", 50),
                "num_of_dialogs",
                minimum=1,
                maximum=500,
            ),
        }

    @staticmethod
    def _decode_import(value: Any, encoding: str) -> str | None:
        if value in (None, ""):
            return None
        text = str(value)
        if encoding == "plain" or (encoding == "auto" and text.lstrip().startswith(("{", "["))):
            return text
        try:
            return base64.b64decode(text, validate=True).decode("utf-8")
        except (binascii.Error, UnicodeDecodeError) as exc:
            raise SkillValidationError("import_blob is not valid UTF-8/base64") from exc

    @staticmethod
    def _guided_flow(import_text: str | None) -> dict[str, Any] | None:
        if not import_text:
            return None
        try:
            value = json.loads(import_text)
        except json.JSONDecodeError:
            return None
        if not isinstance(value, Mapping) or value.get("kind") != _GUIDED_FLOW_KIND:
            return None
        if value.get("version") != _GUIDED_FLOW_VERSION:
            raise SkillValidationError("guided sign-in configuration version is unsupported")

        target = required_text(value.get("target"), "target", maximum=128)
        text = required_text(value.get("text"), "text", maximum=4000)
        button_text = str(value.get("button_text") or "").strip()
        if len(button_text) > 128:
            raise SkillValidationError("button_text is too long")
        raw_keywords = value.get("success_keywords") or []
        if not isinstance(raw_keywords, list):
            raise SkillValidationError("success_keywords must be a list")
        keywords = []
        for item in raw_keywords[:10]:
            keyword = str(item).strip()
            if keyword and len(keyword) <= 100:
                keywords.append(keyword)
        wait_seconds = optional_int(
            value.get("wait_seconds", 30),
            "wait_seconds",
            minimum=5,
            maximum=120,
        )
        thread_id = optional_int(
            value.get("message_thread_id"),
            "message_thread_id",
            minimum=1,
        )
        return {
            "target": target,
            "text": text,
            "button_text": button_text,
            "success_keywords": keywords,
            "wait_seconds": wait_seconds,
            "message_thread_id": thread_id,
        }

    @staticmethod
    async def _recent_messages(signer, target: str | int, after_id: int) -> list[Any]:
        messages: list[Any] = []
        async for message in signer.app.get_chat_history(target, limit=20):
            message_id = int(getattr(message, "id", 0) or 0)
            if message_id <= after_id:
                break
            messages.append(message)
        messages.reverse()
        return messages

    async def _execute_guided(self, signer, flow: dict[str, Any]) -> dict[str, Any]:
        await signer.login(num_of_dialogs=1, print_chat=False)
        target = _target(flow["target"])
        text = flow["text"]
        button_text = flow["button_text"]
        success_keywords = flow["success_keywords"]
        wait_seconds = flow["wait_seconds"]

        async with signer.app:
            sent = await signer.send_message(
                target,
                text,
                message_thread_id=flow["message_thread_id"],
            )
            sent_id = int(getattr(sent, "id", 0) or 0)
            if not button_text and not success_keywords:
                return {"sent": True, "button_clicked": False, "success_confirmed": False}

            loop = asyncio.get_running_loop()
            deadline = loop.time() + wait_seconds
            last_seen_id = sent_id
            clicked = False
            while loop.time() < deadline:
                for message in await self._recent_messages(signer, target, last_seen_id):
                    message_id = int(getattr(message, "id", 0) or 0)
                    last_seen_id = max(last_seen_id, message_id)
                    message_text = _message_text(message)
                    if success_keywords and _contains_any(message_text, success_keywords):
                        return {
                            "sent": True,
                            "button_clicked": clicked,
                            "success_confirmed": True,
                            "matched_reply": message_text[:240],
                        }
                    if button_text and not clicked:
                        for actual_text in _button_texts(message):
                            if button_text.casefold() in actual_text.casefold():
                                await message.click(actual_text)
                                clicked = True
                                if not success_keywords:
                                    return {
                                        "sent": True,
                                        "button_clicked": True,
                                        "success_confirmed": False,
                                    }
                                break
                await asyncio.sleep(1)

        waiting_for = "按钮和成功回复" if button_text and success_keywords else "按钮" if button_text else "成功回复"
        raise SkillError(
            f"等待{waiting_for}超时，请检查按钮文字或成功关键词。",
            code="guided_signin_timeout",
            retryable=False,
            # The initial command was already sent. Retrying could duplicate a sign-in or message.
            ambiguous=True,
        )

    def execute(self, context: SkillContext, params: Mapping[str, Any]) -> SkillResult:
        effective_params = dict(params)
        if not effective_params.get("import_blob"):
            effective_params["import_blob"] = context.secrets.get(
                "tg_signer_import_base64", context.secrets.get("import_blob")
            )
        values = self.validate(effective_params)
        import_text = self._decode_import(
            values["import_blob"], values["import_encoding"]
        )
        guided_flow = self._guided_flow(import_text)
        try:
            with SecretWorkspace(prefix="telegram-signer-") as workspace:
                with telegram_environment(context.secrets):
                    signer = build_signer(
                        context,
                        task_name=values["task_name"],
                        workspace=workspace,
                    )
                    if guided_flow is not None:
                        result = signer.loop.run_until_complete(
                            self._execute_guided(signer, guided_flow)
                        )
                        return SkillResult(data={"task_name": values["task_name"], **result})
                    if import_text is not None:
                        # Existing tg-signer JSON/Base64 tasks continue to use the legacy importer.
                        signer.import_(import_text)
                    signer.app_run(signer.run_once(values["num_of_dialogs"]))
            return SkillResult(data={"task_name": values["task_name"], "completed": True})
        except Exception as exc:
            if isinstance(exc, (SkillError, SkillValidationError)):
                raise
            raise classify_telegram_exception(exc) from exc


__test__ = {
    "guided_flow_kind": _GUIDED_FLOW_KIND,
    "guided_flow_version": _GUIDED_FLOW_VERSION,
}
