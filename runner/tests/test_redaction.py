import unittest

from runner.redaction import Redactor


class RedactorTests(unittest.TestCase):
    def test_redacts_exact_secrets_proxy_credentials_and_sensitive_fields(self):
        redactor = Redactor(
            ["session-value", "api-hash", "123456", "two-factor-secret"]
        )
        value = {
            "message": (
                "session-value api-hash code=123456 "
                "socks5://alice:proxy-pass@example.test:1080"
            ),
            "password": "two-factor-secret",
            "nested": {"phone_code": "123456", "safe": "ok"},
        }

        sanitized = redactor.redact(value)

        rendered = repr(sanitized)
        for secret in ("session-value", "api-hash", "123456", "two-factor-secret", "proxy-pass"):
            self.assertNotIn(secret, rendered)
        self.assertEqual(sanitized["nested"]["safe"], "ok")
        self.assertIn("***", rendered)

    def test_preserves_non_sensitive_values(self):
        self.assertEqual(Redactor([]).redact("ordinary output"), "ordinary output")

    def test_short_code_password_and_proxy_password_are_never_echoed(self):
        redactor = Redactor.from_mapping(
            {
                "verification_code": "12",
                "password": "x",
                "proxy": "socks5://user:p@example.test:1080",
            }
        )

        output = redactor.text(
            "invalid verification value 12; password x; proxy socks5://user:p@example.test:1080"
        )

        self.assertNotIn(" 12", output)
        self.assertNotIn("password x", output)
        self.assertNotIn("user:p@", output)


if __name__ == "__main__":
    unittest.main()
