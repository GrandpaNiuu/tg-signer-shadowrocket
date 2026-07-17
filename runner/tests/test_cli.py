import argparse
import contextlib
import io
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from runner.cli import task_finalize, task_run


class FinalizerTests(unittest.TestCase):
    def test_task_startup_error_is_redacted_with_claimed_secrets(self) -> None:
        client = mock.Mock()
        claim = {
            "account": {"secrets": {"session_string": "session-secret"}}
        }
        client.claim_task.return_value = claim

        with tempfile.TemporaryDirectory() as temp_dir:
            result_file = Path(temp_dir, "result.json")
            args = argparse.Namespace(run_id="run-1", result_file=str(result_file))
            with (
                mock.patch("runner.cli.build_client", return_value=client),
                mock.patch(
                    "runner.cli.TaskSpec.from_claim",
                    side_effect=RuntimeError("invalid session-secret"),
                ),
            ):
                code = task_run(args)

            rendered = result_file.read_text(encoding="utf-8")

        self.assertEqual(code, 1)
        self.assertNotIn("session-secret", rendered)
        self.assertIn("***", rendered)
        self.assertNotIn("session-secret", repr(client.complete_task.call_args))

    def test_task_claim_secrets_are_masked_before_engine_runs(self) -> None:
        output = io.StringIO()
        client = mock.Mock()
        claim = {
            "account": {
                "phone": "+10000000000",
                "api_hash": "api-hash-secret",
                "secrets": {"session_string": "session-secret"},
            }
        }
        client.claim_task.return_value = claim
        expected_spec = object()

        class ObservingEngine:
            def __init__(_self, _client):
                pass

            def run(_self, spec):
                self.assertIs(spec, expected_spec)
                rendered = output.getvalue()
                self.assertIn("::add-mask::session-secret", rendered)
                self.assertIn("::add-mask::api-hash-secret", rendered)
                self.assertIn("::add-mask::+10000000000", rendered)
                return {"status": "success"}

        with tempfile.TemporaryDirectory() as temp_dir:
            args = argparse.Namespace(
                run_id="run-1", result_file=str(Path(temp_dir, "result.json"))
            )
            with (
                mock.patch.dict("os.environ", {"GITHUB_ACTIONS": "true"}),
                mock.patch("runner.cli.build_client", return_value=client),
                mock.patch("runner.cli.TaskSpec.from_claim", return_value=expected_spec),
                mock.patch("runner.cli.Engine", ObservingEngine),
                contextlib.redirect_stdout(output),
            ):
                code = task_run(args)

        self.assertEqual(code, 0)

    def test_missing_result_is_recorded_as_ambiguous(self) -> None:
        client = mock.Mock()
        with tempfile.TemporaryDirectory() as temp_dir:
            result_file = Path(temp_dir, "missing.json")
            args = argparse.Namespace(run_id="run-1", result_file=str(result_file))
            with mock.patch("runner.cli.build_client", return_value=client):
                task_finalize(args)

        payload = client.complete_task.call_args.args[1]
        self.assertEqual(payload["status"], "ambiguous")
        self.assertTrue(payload["error"]["ambiguous"])


if __name__ == "__main__":
    unittest.main()
