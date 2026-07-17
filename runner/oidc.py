from __future__ import annotations

import json
import os
import time
import urllib.parse
import urllib.request
from typing import Callable


class OIDCError(RuntimeError):
    pass


class GitHubOIDCProvider:
    """Fetch short-lived GitHub Actions OIDC tokens without a long-lived API key."""

    def __init__(
        self,
        audience: str,
        *,
        request_url: str | None = None,
        request_token: str | None = None,
        opener: Callable = urllib.request.urlopen,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self.audience = audience
        self.request_url = request_url or os.environ.get("ACTIONS_ID_TOKEN_REQUEST_URL", "")
        self.request_token = request_token or os.environ.get(
            "ACTIONS_ID_TOKEN_REQUEST_TOKEN", ""
        )
        self.opener = opener
        self.monotonic = monotonic
        self._cached_token = ""
        self._cached_at = 0.0

    def token(self) -> str:
        if self._cached_token and self.monotonic() - self._cached_at < 240:
            return self._cached_token
        if not self.audience or not self.request_url or not self.request_token:
            raise OIDCError("GitHub Actions OIDC environment is not configured")
        separator = "&" if "?" in self.request_url else "?"
        url = self.request_url + separator + urllib.parse.urlencode(
            {"audience": self.audience}
        )
        request = urllib.request.Request(
            url,
            headers={
                "Authorization": f"Bearer {self.request_token}",
                "Accept": "application/json",
            },
        )
        try:
            with self.opener(request, timeout=15) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except Exception as exc:
            raise OIDCError("could not obtain GitHub OIDC token") from exc
        token = str(payload.get("value", ""))
        if not token:
            raise OIDCError("GitHub OIDC response did not include a token")
        self._cached_token = token
        self._cached_at = self.monotonic()
        return token
