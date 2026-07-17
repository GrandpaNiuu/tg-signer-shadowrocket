import io
import json
import unittest

from runner.github_mask import GitHubMasker


class GitHubMaskerTests(unittest.TestCase):
    def test_registers_proxy_password_from_worker_json_and_encoded_url(self):
        output = io.StringIO()
        masker = GitHubMasker(output=output, enabled=True)

        masker.add_mapping(
            {
                "account": {
                    "proxy": json.dumps(
                        {
                            "protocol": "socks5",
                            "host": "proxy.example",
                            "port": 1080,
                            "username": "alice",
                            "password": "json-password",
                        }
                    )
                }
            }
        )
        masker.add_mapping(
            {"account": {"proxy": "socks5://alice:url%2Dpassword@proxy.example:1080"}}
        )

        commands = output.getvalue()
        self.assertIn("::add-mask::json-password\n", commands)
        self.assertIn("::add-mask::url%252Dpassword\n", commands)
        self.assertIn("::add-mask::url-password\n", commands)

    def test_registers_nested_dynamic_secrets_with_workflow_command_escaping(self):
        output = io.StringIO()
        masker = GitHubMasker(output=output, enabled=True)

        masker.add_mapping(
            {
                "task": {
                    "command": "/checkin",
                    "params": {"import_blob": "encrypted-signer-config"},
                },
                "account": {
                    "phone": "+10000000000",
                    "api_id": 123456,
                    "api_hash": "hash%with\r\nlines",
                    "secrets": {"session_string": "session-secret"},
                    "proxy": {
                        "scheme": "socks5",
                        "hostname": "proxy.example",
                        "port": 1080,
                        "username": "alice",
                        "password": "proxy-password",
                    },
                },
            }
        )

        commands = output.getvalue()
        self.assertIn("::add-mask::session-secret\n", commands)
        self.assertIn("::add-mask::hash%25with%0D%0Alines\n", commands)
        self.assertIn("::add-mask::+10000000000\n", commands)
        self.assertIn("::add-mask::proxy-password\n", commands)
        self.assertIn("::add-mask::encrypted-signer-config\n", commands)
        self.assertNotIn("::add-mask::/checkin", commands)


if __name__ == "__main__":
    unittest.main()
