import json
import sys
import types
import unittest
from unittest import mock

from runner.login import (
    KurigramLoginAdapter,
    PasswordRequired,
    RecoverableLoginInputError,
    TelegramLoginRunner,
)


class FakeWorkerClient:
    def __init__(self, inputs):
        self.inputs = list(inputs)
        self.events = []
        self.completions = []

    def claim_login(self, flow_id):
        return {
            "flow": {"id": flow_id, "timeout_seconds": 60},
            "account": {
                "phone": "+10000000000",
                "api_id": 123,
                "api_hash": "api-secret",
            },
        }

    def report_login_event(self, flow_id, payload):
        self.events.append((flow_id, payload))

    def claim_login_input(self, flow_id, expected):
        if not self.inputs:
            return None
        kind, value = self.inputs[0]
        if kind != expected:
            return None
        self.inputs.pop(0)
        return {"kind": kind, "value": value}

    def claim_login_resend(self, flow_id):
        payload = self.claim_login_input(flow_id, "resend")
        return bool(payload and payload["value"] == "requested")

    def complete_login(self, flow_id, payload):
        self.completions.append((flow_id, payload))


class FakeAdapter:
    def __init__(self, require_password=True):
        self.require_password = require_password
        self.disconnected = False

    def send_code(self, phone):
        return "phone-code-hash-secret"

    def sign_in(self, phone, phone_code_hash, code):
        if self.require_password:
            raise PasswordRequired()

    def check_password(self, password):
        self.require_password = False

    def export_session(self):
        return "new-session-secret"

    def verify_account(self):
        return {"id": 42, "username": "alice"}

    def close(self):
        self.disconnected = True


class EchoingCodeAdapter(FakeAdapter):
    def sign_in(self, phone, phone_code_hash, code):
        raise RuntimeError(f"invalid verification code {code}; hash={phone_code_hash}")


class FloodWait(Exception):
    def __init__(self, seconds):
        super().__init__(f"wait {seconds} seconds")
        self.value = seconds


class LoginRunnerTests(unittest.TestCase):
    def test_initial_send_code_transport_error_retries_without_terminal_failure(self):
        class TransportOnceAdapter(FakeAdapter):
            def __init__(self):
                super().__init__(require_password=False)
                self.send_attempts = 0

            def send_code(self, phone):
                self.send_attempts += 1
                if self.send_attempts == 1:
                    raise TimeoutError("temporary socket timeout")
                return super().send_code(phone)

        client = FakeWorkerClient([("code", "12345")])
        adapter = TransportOnceAdapter()
        sleeps = []
        result = TelegramLoginRunner(
            client,
            adapter_factory=lambda _claim: adapter,
            masker=mock.Mock(),
            sleep=sleeps.append,
            monotonic=self._clock(),
        ).run("flow-1")

        self.assertEqual(result["status"], "connected")
        self.assertEqual(adapter.send_attempts, 2)
        self.assertEqual(sleeps, [1])
        self.assertEqual(client.events[0][1], {
            "state": "starting",
            "error": {
                "code": "telegram_transport",
                "message": "Telegram is temporarily unavailable; retrying.",
            },
        })
        self.assertFalse(any(payload.get("status") == "failed" for _, payload in client.completions))

    def test_manual_resend_flood_wait_retries_in_same_code_flow(self):
        class FloodWaitOnceAdapter(FakeAdapter):
            def __init__(self):
                super().__init__(require_password=False)
                self.resend_attempts = 0
                self.sign_in_hash = None

            def resend_code(self, phone, phone_code_hash):
                self.resend_attempts += 1
                if self.resend_attempts == 1:
                    raise FloodWait(4)
                return "resent-code-hash"

            def sign_in(self, phone, phone_code_hash, code):
                self.sign_in_hash = phone_code_hash

        client = FakeWorkerClient([("resend", "requested"), ("code", "12345")])
        adapter = FloodWaitOnceAdapter()
        sleeps = []
        result = TelegramLoginRunner(
            client,
            adapter_factory=lambda _claim: adapter,
            masker=mock.Mock(),
            sleep=sleeps.append,
            monotonic=self._clock(),
        ).run("flow-1")

        self.assertEqual(result["status"], "connected")
        self.assertEqual(adapter.resend_attempts, 2)
        self.assertEqual(adapter.sign_in_hash, "resent-code-hash")
        self.assertEqual(sleeps, [4])
        retry_event = client.events[1][1]
        self.assertEqual(retry_event, {
            "state": "code_required",
            "error": {
                "code": "flood_wait",
                "message": "Telegram requested a short wait; retrying automatically.",
            },
        })
        self.assertFalse(any(payload.get("status") == "failed" for _, payload in client.completions))

    def test_resend_control_refreshes_hash_while_waiting_for_code(self):
        class ResendAdapter(FakeAdapter):
            def __init__(self):
                super().__init__(require_password=False)
                self.resends = []
                self.sign_in_hash = None

            def resend_code(self, phone, phone_code_hash):
                self.resends.append((phone, phone_code_hash))
                return "manually-resent-hash"

            def sign_in(self, phone, phone_code_hash, code):
                self.sign_in_hash = phone_code_hash

        client = FakeWorkerClient(
            [("resend", "requested"), ("code", "12345")]
        )
        adapter = ResendAdapter()
        result = TelegramLoginRunner(
            client,
            adapter_factory=lambda _claim: adapter,
            masker=mock.Mock(),
            sleep=lambda _: None,
            monotonic=self._clock(),
        ).run("flow-1")

        self.assertEqual(result["status"], "connected")
        self.assertEqual(
            adapter.resends,
            [("+10000000000", "phone-code-hash-secret")],
        )
        self.assertEqual(adapter.sign_in_hash, "manually-resent-hash")

    def test_kurigram_resend_code_replaces_phone_code_hash(self):
        seen = []

        class Client:
            def __init__(self, _name, **_kwargs):
                pass

            def connect(self):
                pass

            def resend_code(self, phone, phone_code_hash):
                seen.append((phone, phone_code_hash))
                return types.SimpleNamespace(phone_code_hash="replacement-hash")

        module = types.SimpleNamespace(Client=Client)
        claim = {"account": {"api_id": 123, "api_hash": "api-secret"}}
        with mock.patch.dict(sys.modules, {"pyrogram": module}):
            adapter = KurigramLoginAdapter(claim)

        result = adapter.resend_code("+10000000000", "old-hash")

        self.assertEqual(result, "replacement-hash")
        self.assertEqual(seen, [("+10000000000", "old-hash")])

    def test_expired_code_is_resent_and_new_hash_is_used(self):
        class ExpiredOnceAdapter(FakeAdapter):
            def __init__(self):
                super().__init__(require_password=False)
                self.hashes = []
                self.resends = []

            def sign_in(self, phone, phone_code_hash, code):
                self.hashes.append(phone_code_hash)
                if len(self.hashes) == 1:
                    raise RecoverableLoginInputError(
                        "code", "phone_code_expired", resend_code=True
                    )

            def resend_code(self, phone, phone_code_hash):
                self.resends.append((phone, phone_code_hash))
                return "replacement-code-hash"

        client = FakeWorkerClient([("code", "11111"), ("code", "22222")])
        adapter = ExpiredOnceAdapter()
        masker = mock.Mock()
        result = TelegramLoginRunner(
            client,
            adapter_factory=lambda _claim: adapter,
            masker=masker,
            sleep=lambda _: None,
            monotonic=self._clock(),
        ).run("flow-1")

        self.assertEqual(result["status"], "connected")
        self.assertEqual(
            adapter.resends,
            [("+10000000000", "phone-code-hash-secret")],
        )
        self.assertEqual(
            adapter.hashes,
            ["phone-code-hash-secret", "replacement-code-hash"],
        )
        masker.add.assert_any_call("replacement-code-hash")

    def test_kurigram_classifies_invalid_password_as_recoverable(self):
        class PasswordHashInvalid(Exception):
            pass

        class Client:
            def __init__(self, _name, **_kwargs):
                pass

            def connect(self):
                pass

            def check_password(self, _password):
                raise PasswordHashInvalid("must not be exposed")

        module = types.SimpleNamespace(Client=Client)
        claim = {"account": {"api_id": 123, "api_hash": "api-secret"}}
        with mock.patch.dict(sys.modules, {"pyrogram": module}):
            adapter = KurigramLoginAdapter(claim)

        with self.assertRaises(RecoverableLoginInputError) as rejected:
            adapter.check_password("wrong-password")
        self.assertEqual(rejected.exception.kind, "password")
        self.assertEqual(rejected.exception.code, "password_invalid")

    def test_kurigram_classifies_invalid_and_expired_codes_as_recoverable(self):
        class PhoneCodeInvalid(Exception):
            pass

        class PhoneCodeExpired(Exception):
            pass

        class Client:
            error = PhoneCodeInvalid

            def __init__(self, _name, **_kwargs):
                pass

            def connect(self):
                pass

            def sign_in(self, *_args):
                raise self.error("must not be exposed")

        module = types.SimpleNamespace(Client=Client)
        claim = {"account": {"api_id": 123, "api_hash": "api-secret"}}
        with mock.patch.dict(sys.modules, {"pyrogram": module}):
            adapter = KurigramLoginAdapter(claim)

        with self.assertRaises(RecoverableLoginInputError) as invalid:
            adapter.sign_in("+10000000000", "hash", "11111")
        self.assertEqual(invalid.exception.code, "phone_code_invalid")
        self.assertFalse(invalid.exception.resend_code)

        Client.error = PhoneCodeExpired
        with self.assertRaises(RecoverableLoginInputError) as expired:
            adapter.sign_in("+10000000000", "hash", "11111")
        self.assertEqual(expired.exception.code, "phone_code_expired")
        self.assertTrue(expired.exception.resend_code)

    def test_invalid_two_factor_password_returns_to_password_required(self):
        class InvalidPasswordOnceAdapter(FakeAdapter):
            def __init__(self):
                super().__init__(require_password=True)
                self.passwords = []

            def check_password(self, password):
                self.passwords.append(password)
                if len(self.passwords) == 1:
                    raise RecoverableLoginInputError("password", "password_invalid")
                self.require_password = False

        client = FakeWorkerClient(
            [
                ("code", "12345"),
                ("password", "wrong-password"),
                ("password", "right-password"),
            ]
        )
        adapter = InvalidPasswordOnceAdapter()
        result = TelegramLoginRunner(
            client,
            adapter_factory=lambda _claim: adapter,
            masker=mock.Mock(),
            sleep=lambda _: None,
            monotonic=self._clock(),
        ).run("flow-1")

        self.assertEqual(result["status"], "connected")
        self.assertEqual(adapter.passwords, ["wrong-password", "right-password"])
        self.assertEqual(
            [payload["state"] for _, payload in client.events],
            ["code_required", "password_required", "password_required"],
        )
        self.assertEqual(
            client.events[-1][1]["error"],
            {
                "code": "password_invalid",
                "message": "The two-factor password was rejected.",
            },
        )

    def test_invalid_code_returns_to_code_required_and_accepts_replacement(self):
        class InvalidOnceAdapter(FakeAdapter):
            def __init__(self):
                super().__init__(require_password=False)
                self.codes = []

            def sign_in(self, phone, phone_code_hash, code):
                self.codes.append(code)
                if len(self.codes) == 1:
                    raise RecoverableLoginInputError("code", "phone_code_invalid")

        client = FakeWorkerClient([("code", "11111"), ("code", "22222")])
        adapter = InvalidOnceAdapter()
        result = TelegramLoginRunner(
            client,
            adapter_factory=lambda _claim: adapter,
            masker=mock.Mock(),
            sleep=lambda _: None,
            monotonic=self._clock(),
        ).run("flow-1")

        self.assertEqual(result["status"], "connected")
        self.assertEqual(adapter.codes, ["11111", "22222"])
        self.assertEqual(
            [payload["state"] for _, payload in client.events],
            ["code_required", "code_required"],
        )
        self.assertEqual(
            client.events[-1][1]["error"],
            {
                "code": "phone_code_invalid",
                "message": "The verification code was rejected.",
            },
        )

    def test_interactive_login_verifies_get_me_before_exporting_session(self):
        class VerifyingAdapter(FakeAdapter):
            def __init__(self):
                super().__init__(require_password=False)
                self.verified = False

            def verify_account(self):
                self.verified = True
                return {"id": 42, "username": "alice"}

            def export_session(self):
                if not self.verified:
                    raise AssertionError("session exported before get_me verification")
                return super().export_session()

        client = FakeWorkerClient([("code", "12345")])
        adapter = VerifyingAdapter()
        result = TelegramLoginRunner(
            client,
            adapter_factory=lambda _claim: adapter,
            masker=mock.Mock(),
            sleep=lambda _: None,
            monotonic=self._clock(),
        ).run("flow-1")

        self.assertEqual(result["status"], "connected")
        self.assertTrue(adapter.verified)

    def test_kurigram_validation_uses_existing_session_and_get_me(self):
        seen = {}

        class Client:
            def __init__(self, _name, **kwargs):
                seen.update(kwargs)

            def connect(self):
                pass

            def get_me(self):
                return types.SimpleNamespace(id=42, username="alice")

        module = types.SimpleNamespace(Client=Client)
        claim = {
            "account": {
                "session_string": "existing-session-secret",
            }
        }
        with mock.patch.dict(sys.modules, {"pyrogram": module}):
            adapter = KurigramLoginAdapter(claim)
            identity = adapter.verify_account()

        self.assertEqual(seen["session_string"], "existing-session-secret")
        self.assertNotIn("api_id", seen)
        self.assertNotIn("api_hash", seen)
        self.assertEqual(identity, {"id": 42, "username": "alice"})

    def test_kurigram_interactive_login_requires_api_credentials(self):
        class Client:
            def __init__(self, _name, **_kwargs):
                raise AssertionError("client must not be created without API credentials")

        module = types.SimpleNamespace(Client=Client)
        claim = {"account": {"phone": "+8613812345678"}}
        with mock.patch.dict(sys.modules, {"pyrogram": module}):
            with self.assertRaisesRegex(ValueError, "api_id and api_hash"):
                KurigramLoginAdapter(claim)

    def test_session_validation_uses_get_me_without_starting_interactive_login(self):
        class ValidationClient(FakeWorkerClient):
            def claim_login(self, flow_id):
                return {
                    "flow": {
                        "id": flow_id,
                        "mode": "session_validation",
                        "timeout_seconds": 60,
                    },
                    "account": {
                        "session_string": "existing-session-secret",
                    },
                }

        class ValidationAdapter:
            def __init__(self):
                self.verified = False
                self.disconnected = False

            def verify_account(self):
                self.verified = True
                return {"id": 42, "username": "alice"}

            def send_code(self, _phone):
                raise AssertionError("validation must not send a code")

            def export_session(self):
                raise AssertionError("validation must not replace the session")

            def close(self):
                self.disconnected = True

        client = ValidationClient([])
        adapter = ValidationAdapter()
        result = TelegramLoginRunner(
            client,
            adapter_factory=lambda _claim: adapter,
            masker=mock.Mock(),
            sleep=lambda _: None,
            monotonic=self._clock(),
        ).run("flow-validation")

        self.assertEqual(result["status"], "connected")
        self.assertTrue(adapter.verified)
        self.assertTrue(adapter.disconnected)
        self.assertEqual(
            client.completions,
            [("flow-validation", {"status": "connected"})],
        )

    def test_dynamic_login_secrets_are_masked_before_they_are_used(self):
        client = FakeWorkerClient(
            [("code", "12345"), ("password", "two-factor-secret")]
        )
        masked = set()

        class Masker:
            def add_mapping(self, value):
                account = value["account"]
                masked.update(
                    {
                        str(account["phone"]),
                        str(account["api_id"]),
                        str(account["api_hash"]),
                    }
                )

            def add(self, *values):
                masked.update(str(value) for value in values if value)

        class ObservingAdapter(FakeAdapter):
            def send_code(self, phone):
                self.assert_masked(phone)
                return super().send_code(phone)

            def sign_in(self, phone, phone_code_hash, code):
                self.assert_masked(phone, phone_code_hash, code)
                return super().sign_in(phone, phone_code_hash, code)

            def check_password(self, password):
                self.assert_masked(password)
                return super().check_password(password)

            @staticmethod
            def assert_masked(*values):
                for value in values:
                    if str(value) not in masked:
                        raise AssertionError(f"value was used before masking: {value!r}")

        adapter = ObservingAdapter()
        runner = TelegramLoginRunner(
            client,
            adapter_factory=lambda claim: (
                self.assertTrue({claim["account"]["phone"], claim["account"]["api_hash"]} <= masked)
                or adapter
            ),
            masker=Masker(),
            sleep=lambda _: None,
            monotonic=self._clock(),
        )

        result = runner.run("flow-1")

        self.assertEqual(result["status"], "connected")
        self.assertIn("new-session-secret", masked)

    def test_kurigram_receives_decoded_worker_proxy(self):
        seen = {}

        class Client:
            def __init__(self, _name, **kwargs):
                seen.update(kwargs)

            def connect(self):
                seen["connected"] = True

        module = types.SimpleNamespace(Client=Client)
        claim = {
            "account": {
                "api_id": 123,
                "api_hash": "api-secret",
                "proxy": json.dumps(
                    {
                        "protocol": "socks5",
                        "host": "proxy.example",
                        "port": 1080,
                        "username": "alice",
                        "password": "private-password",
                    }
                ),
            }
        }
        with mock.patch.dict(sys.modules, {"pyrogram": module}):
            KurigramLoginAdapter(claim)

        self.assertEqual(
            seen["proxy"],
            {
                "scheme": "socks5",
                "hostname": "proxy.example",
                "port": 1080,
                "username": "alice",
                "password": "private-password",
            },
        )
        self.assertTrue(seen["connected"])

    def test_code_and_password_never_appear_in_events_or_result(self):
        client = FakeWorkerClient(
            [("code", "12345"), ("password", "two-factor-secret")]
        )
        adapter = FakeAdapter()
        runner = TelegramLoginRunner(
            client,
            adapter_factory=lambda _claim: adapter,
            sleep=lambda _: None,
            monotonic=self._clock(),
        )

        result = runner.run("flow-1")

        self.assertEqual(result["status"], "connected")
        rendered_events = repr(client.events)
        self.assertNotIn("12345", rendered_events)
        self.assertNotIn("two-factor-secret", rendered_events)
        self.assertNotIn("phone-code-hash-secret", rendered_events)
        self.assertNotIn("new-session-secret", repr(result))
        self.assertEqual(client.completions[-1][1]["session_string"], "new-session-secret")
        self.assertTrue(adapter.disconnected)

    def test_exception_that_echoes_code_is_redacted_before_callback(self):
        client = FakeWorkerClient([("code", "98765")])
        runner = TelegramLoginRunner(
            client,
            adapter_factory=lambda _claim: EchoingCodeAdapter(False),
            sleep=lambda _: None,
            monotonic=self._clock(),
        )

        result = runner.run("flow-1")

        rendered = repr(result) + repr(client.completions)
        self.assertNotIn("98765", rendered)
        self.assertNotIn("phone-code-hash-secret", rendered)
        self.assertIn("***", rendered)

    @staticmethod
    def _clock():
        value = [0.0]

        def now():
            value[0] += 0.1
            return value[0]

        return now


if __name__ == "__main__":
    unittest.main()
