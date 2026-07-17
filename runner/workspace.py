from __future__ import annotations

import os
import pathlib
import shutil
import tempfile
from types import TracebackType
from typing import Optional, Type


class SecretWorkspace:
    """Private, random workspace for data a Telegram library must persist briefly."""

    def __init__(self, *, prefix: str = "telegram-runner-") -> None:
        self.prefix = prefix
        self.path: pathlib.Path

    def __enter__(self) -> "SecretWorkspace":
        self.path = pathlib.Path(tempfile.mkdtemp(prefix=self.prefix))
        try:
            self.path.chmod(0o700)
        except OSError:
            pass
        return self

    def write_text(self, relative_path: str, value: str) -> pathlib.Path:
        path = self.path / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(path, flags, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(value)
        try:
            path.chmod(0o600)
        except OSError:
            pass
        return path

    def __exit__(
        self,
        exc_type: Optional[Type[BaseException]],
        exc: Optional[BaseException],
        traceback: Optional[TracebackType],
    ) -> None:
        shutil.rmtree(self.path, ignore_errors=True)
