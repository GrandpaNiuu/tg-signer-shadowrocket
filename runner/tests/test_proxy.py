import json
import unittest

from runner.proxy import ProxyConfigurationError, decode_proxy


class ProxyDecoderTests(unittest.TestCase):
    def test_decodes_worker_json_object(self) -> None:
        value = json.dumps(
            {
                "protocol": "socks5",
                "host": "proxy.example",
                "port": 1080,
                "username": "alice",
                "password": "private-password",
            }
        )

        self.assertEqual(
            decode_proxy(value),
            {
                "scheme": "socks5",
                "hostname": "proxy.example",
                "port": 1080,
                "username": "alice",
                "password": "private-password",
            },
        )

    def test_decodes_legacy_url(self) -> None:
        self.assertEqual(
            decode_proxy("socks5://alice:private-password@proxy.example:1080"),
            {
                "scheme": "socks5",
                "hostname": "proxy.example",
                "port": 1080,
                "username": "alice",
                "password": "private-password",
            },
        )

    def test_no_proxy_returns_none(self) -> None:
        for value in (None, "", "   "):
            with self.subTest(value=value):
                self.assertIsNone(decode_proxy(value))

    def test_invalid_input_never_echoes_credentials(self) -> None:
        secret = "private-password"
        invalid_values = (
            f'{{"protocol":"socks5","password":"{secret}"',
            {"protocol": "socks5", "host": "proxy.example", "port": 0, "password": secret},
            f"ftp://alice:{secret}@proxy.example:21",
            f"socks5://alice:{secret}@proxy.example:not-a-port",
        )
        for value in invalid_values:
            with self.subTest(kind=type(value).__name__):
                with self.assertRaises(ProxyConfigurationError) as caught:
                    decode_proxy(value)
                self.assertEqual(str(caught.exception), "proxy configuration is invalid")
                self.assertNotIn(secret, str(caught.exception))


if __name__ == "__main__":
    unittest.main()
