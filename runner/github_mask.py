from __future__ import annotations

import os
import sys
from collections.abc import Mapping
from typing import Any, TextIO

from runner.redaction import sensitive_values_from_mapping


class GitHubMasker:
    """Register dynamic secrets with the GitHub Actions log processor."""

    def __init__(
        self,
        *,
        output: TextIO | None = None,
        enabled: bool | None = None,
    ) -> None:
        self.output = output or sys.stdout
        self.enabled = (
            os.environ.get("GITHUB_ACTIONS", "").lower() == "true"
            if enabled is None
            else enabled
        )
        self._registered: set[str] = set()

    def add_mapping(self, value: Mapping[str, Any]) -> None:
        self.add(*sensitive_values_from_mapping(value))

    def add(self, *values: Any) -> None:
        if not self.enabled:
            return
        for value in values:
            if value is None or value == "":
                continue
            secret = str(value)
            if secret in self._registered:
                continue
            self._registered.add(secret)
            self.output.write(f"::add-mask::{_escape_command_data(secret)}\n")
        self.output.flush()


def _escape_command_data(value: str) -> str:
    return value.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
