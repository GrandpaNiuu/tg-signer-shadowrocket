import json
import unittest
import urllib.error

from runner.oidc import GitHubOIDCProvider
from runner.worker_client import WorkerAPIError, WorkerClient


class Response:
    def __init__(self, payload):
        self.payload = json.dumps(payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return None

    def read(self):
        return self.payload


class WorkerClientTests(unittest.TestCase):
    def test_login_resend_claim_uses_one_time_resend_control(self):
        seen = {}

        class TokenProvider:
            def token(self):
                return "oidc-jwt"

        def opener(request, timeout):
            seen["url"] = request.full_url
            seen["body"] = json.loads(request.data)
            return Response({"kind": "resend", "value": "requested"})

        client = WorkerClient(
            "https://worker.example",
            TokenProvider(),
            opener=opener,
        )

        self.assertTrue(client.claim_login_resend("flow-1"))
        self.assertEqual(
            seen,
            {
                "url": "https://worker.example/api/runner/login-flows/flow-1/input/claim",
                "body": {"expected": "resend"},
            },
        )

    def test_oidc_provider_requests_configured_audience_without_exposing_token(self):
        seen = {}

        def opener(request, timeout):
            seen["url"] = request.full_url
            seen["authorization"] = request.headers["Authorization"]
            return Response({"value": "short-lived-jwt"})

        provider = GitHubOIDCProvider(
            "https://worker.example/api/runner",
            request_url="https://token.actions.test?id=1",
            request_token="github-request-token",
            opener=opener,
        )

        self.assertEqual(provider.token(), "short-lived-jwt")
        self.assertIn("audience=https%3A%2F%2Fworker.example%2Fapi%2Frunner", seen["url"])
        self.assertEqual(seen["authorization"], "Bearer github-request-token")

    def test_claim_uses_only_run_id_and_oidc_bearer(self):
        seen = {}

        class TokenProvider:
            def token(self):
                return "oidc-jwt"

        def opener(request, timeout):
            seen["url"] = request.full_url
            seen["body"] = request.data
            seen["authorization"] = request.headers["Authorization"]
            return Response({"run": {"id": "run-1"}})

        client = WorkerClient(
            "https://worker.example",
            TokenProvider(),
            opener=opener,
        )

        client.claim_task("run-1")
        self.assertEqual(
            seen["url"], "https://worker.example/api/runner/runs/run-1/claim"
        )
        self.assertEqual(json.loads(seen["body"]), {})
        self.assertEqual(seen["authorization"], "Bearer oidc-jwt")

    def test_one_time_login_input_claim_is_never_automatically_retried(self):
        calls = []

        class TokenProvider:
            def token(self):
                return "oidc-jwt"

        def opener(request, timeout):
            calls.append(request)
            raise urllib.error.URLError("response was lost")

        client = WorkerClient(
            "https://worker.example",
            TokenProvider(),
            opener=opener,
            sleep=lambda _: None,
        )

        with self.assertRaises(WorkerAPIError):
            client.claim_login_input("flow-1", "code")
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
