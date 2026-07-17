from __future__ import annotations

import time
from collections.abc import Mapping
from typing import Any, Callable

from runner.github_mask import GitHubMasker
from runner.proxy import decode_proxy
from runner.redaction import Redactor
from runner.structured_log import StructuredLogger


class PasswordRequired(RuntimeError):
    pass


class LoginExpired(RuntimeError):
    pass


class RecoverableLoginInputError(RuntimeError):
    def __init__(self, kind: str, code: str, *, resend_code: bool = False) -> None:
        if kind not in {"code", "password"}:
            raise ValueError("recoverable login input kind must be code or password")
        super().__init__(code)
        self.kind = kind
        self.code = code
        self.resend_code = resend_code


class RetryableLoginOperationError(RuntimeError):
    def __init__(self, code: str, retry_after_seconds: int) -> None:
        super().__init__(code)
        self.code = code
        self.retry_after_seconds = retry_after_seconds


def classify_retryable_login_error(exc: BaseException) -> RetryableLoginOperationError | None:
    """Classify only errors that are safe to repeat before Telegram accepts a code."""

    name = type(exc).__name__.lower()
    message = str(exc).lower()
    combined = f"{name} {message}"
    if "floodwait" in combined or "flood_wait" in combined:
        wait_value = getattr(exc, "value", getattr(exc, "x", 1))
        try:
            wait_seconds = min(max(int(wait_value), 1), 900)
        except (TypeError, ValueError):
            wait_seconds = 1
        return RetryableLoginOperationError("flood_wait", wait_seconds)
    if isinstance(exc, (TimeoutError, ConnectionError, OSError)) or any(
        marker in name
        for marker in (
            "timeout",
            "connection",
            "network",
            "transport",
            "serviceunavailable",
            "internalservererror",
        )
    ):
        return RetryableLoginOperationError("telegram_transport", 0)
    return None


class KurigramLoginAdapter:
    """Small adapter around Kurigram/Pyrogram's interactive login API."""

    def __init__(self, claim: Mapping[str, Any]) -> None:
        account = claim.get("account", {})
        if not isinstance(account, Mapping):
            raise ValueError("login account must be an object")
        try:
            from pyrogram import Client
        except ImportError as exc:
            raise RuntimeError("Kurigram dependency is not installed") from exc
        proxy = decode_proxy(account.get("proxy"))
        secrets = account.get("secrets", {})
        session_string = account.get("session_string")
        if not session_string and isinstance(secrets, Mapping):
            session_string = secrets.get("session_string")
        client_options: dict[str, Any] = {
            "proxy": proxy,
            "in_memory": True,
        }
        if session_string:
            client_options["session_string"] = str(session_string)
        else:
            api_id = account.get("api_id")
            api_hash = account.get("api_hash")
            if api_id in (None, "") or api_hash in (None, ""):
                raise ValueError(
                    "api_id and api_hash are required for interactive login"
                )
            client_options["api_id"] = int(api_id)
            client_options["api_hash"] = str(api_hash)
        self.client = Client("telegram_web_login", **client_options)
        self.client.connect()

    def send_code(self, phone: str) -> str:
        result = self.client.send_code(phone)
        return str(result.phone_code_hash)

    def resend_code(self, phone: str, phone_code_hash: str) -> str:
        result = self.client.resend_code(phone, phone_code_hash)
        return str(result.phone_code_hash)

    def sign_in(self, phone: str, phone_code_hash: str, code: str) -> None:
        try:
            self.client.sign_in(phone, phone_code_hash, code)
        except Exception as exc:
            error_name = type(exc).__name__
            if error_name == "SessionPasswordNeeded":
                raise PasswordRequired() from exc
            if error_name in {"PhoneCodeInvalid", "PhoneCodeEmpty", "PhoneCodeHashEmpty"}:
                raise RecoverableLoginInputError("code", "phone_code_invalid") from exc
            if error_name == "PhoneCodeExpired":
                raise RecoverableLoginInputError(
                    "code", "phone_code_expired", resend_code=True
                ) from exc
            raise

    def check_password(self, password: str) -> None:
        try:
            self.client.check_password(password)
        except Exception as exc:
            if type(exc).__name__ in {"PasswordHashInvalid", "PasswordEmpty"}:
                raise RecoverableLoginInputError(
                    "password", "password_invalid"
                ) from exc
            raise

    def export_session(self) -> str:
        return str(self.client.export_session_string())

    def verify_account(self) -> dict[str, Any]:
        user = self.client.get_me()
        user_id = getattr(user, "id", None)
        if user is None or user_id is None:
            raise RuntimeError("Telegram account verification failed")
        return {
            "id": int(user_id),
            "username": getattr(user, "username", None),
        }

    def close(self) -> None:
        try:
            self.client.disconnect()
        except Exception:
            pass


class TelegramLoginRunner:
    def __init__(
        self,
        worker_client,
        *,
        adapter_factory: Callable[[Mapping[str, Any]], Any] = KurigramLoginAdapter,
        masker: GitHubMasker | None = None,
        sleep: Callable[[float], None] = time.sleep,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self.worker_client = worker_client
        self.adapter_factory = adapter_factory
        self.masker = masker or GitHubMasker()
        self.sleep = sleep
        self.monotonic = monotonic

    def run(self, flow_id: str) -> dict[str, Any]:
        claim = self.worker_client.claim_login(flow_id)
        self.masker.add_mapping(claim)
        account = claim.get("account", {})
        if not isinstance(account, Mapping):
            raise ValueError("login account must be an object")
        redactor = Redactor.from_mapping(claim)
        logger = StructuredLogger(redactor)
        flow = claim.get("flow", {})
        timeout = int(flow.get("timeout_seconds", 600)) if isinstance(flow, Mapping) else 600
        deadline = self.monotonic() + min(max(timeout, 60), 900)
        adapter = None
        phone_code_hash = ""
        code = ""
        password = ""
        session_string = ""
        try:
            phone = str(account.get("phone", "")).strip()
            adapter = self.adapter_factory(claim)
            if isinstance(flow, Mapping) and flow.get("mode") == "session_validation":
                adapter.verify_account()
                self.worker_client.complete_login(flow_id, {"status": "connected"})
                result = {"flow_id": flow_id, "status": "connected", "error": None}
                logger.info("session_validated", flow_id=flow_id)
                return result
            if not phone:
                raise ValueError("phone is required")
            phone_code_hash = self._retry_login_operation(
                flow_id,
                state="starting",
                operation="send_code",
                callback=lambda: adapter.send_code(phone),
                deadline=deadline,
                logger=logger,
            )
            self.masker.add(phone_code_hash)
            self.worker_client.report_login_event(
                flow_id, {"state": "code_required"}
            )
            logger.info("login_code_requested", flow_id=flow_id)
            while True:
                code, phone_code_hash = self._wait_for_code(
                    flow_id,
                    phone,
                    phone_code_hash,
                    adapter,
                    deadline,
                    logger,
                )
                try:
                    adapter.sign_in(phone, phone_code_hash, code)
                    code = ""
                    break
                except RecoverableLoginInputError as exc:
                    if exc.kind != "code":
                        raise
                    code = ""
                    if exc.resend_code:
                        phone_code_hash = self._retry_login_operation(
                            flow_id,
                            state="code_required",
                            operation="resend_code",
                            callback=lambda: adapter.resend_code(phone, phone_code_hash),
                            deadline=deadline,
                            logger=logger,
                        )
                        self.masker.add(phone_code_hash)
                        logger.info("login_code_resent", flow_id=flow_id)
                    self.worker_client.report_login_event(
                        flow_id,
                        {
                            "state": "code_required",
                            "error": {
                                "code": exc.code,
                                "message": (
                                    "The verification code expired; a new code was requested."
                                    if exc.code == "phone_code_expired"
                                    else "The verification code was rejected."
                                ),
                            },
                        },
                    )
                    logger.warning("login_code_rejected", flow_id=flow_id, reason=exc.code)
                except PasswordRequired:
                    code = ""
                    self.worker_client.report_login_event(
                        flow_id, {"state": "password_required"}
                    )
                    logger.info("login_password_requested", flow_id=flow_id)
                    while True:
                        password = self._wait_for_input(flow_id, "password", deadline)
                        try:
                            adapter.check_password(password)
                            password = ""
                            break
                        except RecoverableLoginInputError as password_error:
                            if password_error.kind != "password":
                                raise
                            password = ""
                            self.worker_client.report_login_event(
                                flow_id,
                                {
                                    "state": "password_required",
                                    "error": {
                                        "code": password_error.code,
                                        "message": "The two-factor password was rejected.",
                                    },
                                },
                            )
                            logger.warning(
                                "login_password_rejected",
                                flow_id=flow_id,
                                reason=password_error.code,
                            )
                    break
            phone_code_hash = ""
            adapter.verify_account()
            session_string = adapter.export_session()
            self.masker.add(session_string)
            # The only secret-bearing response goes directly to the authenticated Worker.
            self.worker_client.complete_login(
                flow_id,
                {"status": "connected", "session_string": session_string},
            )
            session_string = ""
            result = {"flow_id": flow_id, "status": "connected", "error": None}
            logger.info("login_completed", flow_id=flow_id)
            return result
        except Exception as exc:
            failure_redactor = Redactor.from_mapping(
                {
                    "claim": claim,
                    "phone_code": code,
                    "phone_code_hash": phone_code_hash,
                    "password": password,
                    "session_string": session_string,
                }
            )
            error = {
                "code": "login_expired" if isinstance(exc, LoginExpired) else "login_failed",
                "message": failure_redactor.text(str(exc) or type(exc).__name__),
            }
            self.worker_client.complete_login(
                flow_id, {"status": "failed", "error": error}
            )
            logger.error("login_failed", flow_id=flow_id, error=error)
            return {"flow_id": flow_id, "status": "failed", "error": error}
        finally:
            if adapter is not None:
                adapter.close()

    def _wait_for_code(
        self,
        flow_id: str,
        phone: str,
        phone_code_hash: str,
        adapter,
        deadline: float,
        logger,
    ) -> tuple[str, str]:
        while self.monotonic() < deadline:
            if self.worker_client.claim_login_resend(flow_id):
                phone_code_hash = self._retry_login_operation(
                    flow_id,
                    state="code_required",
                    operation="resend_code",
                    callback=lambda: adapter.resend_code(phone, phone_code_hash),
                    deadline=deadline,
                    logger=logger,
                )
                self.masker.add(phone_code_hash)
                logger.info("login_code_resent", flow_id=flow_id)
            payload = self.worker_client.claim_login_input(flow_id, "code")
            if payload:
                if payload.get("kind", "code") != "code":
                    raise ValueError("Worker returned an unexpected login input kind")
                value = str(payload.get("value", ""))
                if value:
                    self.masker.add(value)
                    return value, phone_code_hash
            self.sleep(3)
        raise LoginExpired("Telegram login flow expired")

    def _retry_login_operation(
        self,
        flow_id: str,
        *,
        state: str,
        operation: str,
        callback: Callable[[], Any],
        deadline: float,
        logger,
    ) -> Any:
        attempt = 0
        reported_transient = False
        while self.monotonic() < deadline:
            try:
                result = callback()
                if reported_transient:
                    self.worker_client.report_login_event(flow_id, {"state": state})
                return result
            except Exception as exc:
                retryable = classify_retryable_login_error(exc)
                if retryable is None:
                    raise
                attempt += 1
                reported_transient = True
                policy_delay = min(30, 2 ** min(attempt - 1, 5))
                retry_delay = max(policy_delay, retryable.retry_after_seconds)
                message = (
                    "Telegram requested a short wait; retrying automatically."
                    if retryable.code == "flood_wait"
                    else "Telegram is temporarily unavailable; retrying."
                )
                self.worker_client.report_login_event(
                    flow_id,
                    {
                        "state": state,
                        "error": {"code": retryable.code, "message": message},
                    },
                )
                logger.warning(
                    "login_operation_retry",
                    flow_id=flow_id,
                    operation=operation,
                    reason=retryable.code,
                    retry_after_seconds=retry_delay,
                )
                remaining = deadline - self.monotonic()
                if remaining <= 0:
                    break
                self.sleep(min(float(retry_delay), remaining))
        raise LoginExpired("Telegram login flow expired while retrying")

    def _wait_for_input(self, flow_id: str, kind: str, deadline: float) -> str:
        while self.monotonic() < deadline:
            payload = self.worker_client.claim_login_input(flow_id, kind)
            if payload:
                if payload.get("kind", kind) != kind:
                    raise ValueError("Worker returned an unexpected login input kind")
                value = str(payload.get("value", ""))
                if value:
                    self.masker.add(value)
                    return value
            self.sleep(3)
        raise LoginExpired("Telegram login flow expired")
