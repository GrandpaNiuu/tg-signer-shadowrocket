from __future__ import annotations

import base64
import binascii
from collections.abc import Mapping
from typing import Any

from runner.skills.base import (
    Skill,
    SkillContext,
    SkillResult,
    optional_int,
    required_text,
)
from runner.skills.telegram_adapter import (
    build_signer,
    classify_telegram_exception,
    telegram_environment,
)
from runner.workspace import SecretWorkspace


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
            from runner.skills.base import SkillValidationError

            raise SkillValidationError("import_blob is not valid UTF-8/base64") from exc

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
        try:
            with SecretWorkspace(prefix="telegram-signer-") as workspace:
                with telegram_environment(context.secrets):
                    signer = build_signer(
                        context,
                        task_name=values["task_name"],
                        workspace=workspace,
                    )
                    if import_text is not None:
                        # The task name is supplied to UserSigner before import. This fixes
                        # the legacy CLI call that omitted tg-signer's required task_name.
                        signer.import_(import_text)
                    signer.app_run(signer.run_once(values["num_of_dialogs"]))
            return SkillResult(data={"task_name": values["task_name"], "completed": True})
        except Exception as exc:
            from runner.skills.base import SkillError

            if isinstance(exc, SkillError):
                raise
            raise classify_telegram_exception(exc) from exc
