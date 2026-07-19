import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

from runner.engine import Engine, SkillExecutionError, SkillTimeout, execute_in_subprocess
from runner.models import TaskSpec


class FakeClient:
    def __init__(self):
        self.attempts = []
        self.completions = []

    def report_attempt(self, run_id, payload):
        self.attempts.append((run_id, payload))

    def complete_task(self, run_id, payload):
        self.completions.append((run_id, payload))


def make_spec(retry=2):
    return TaskSpec(
        run_id="run-1",
        task_id="task-1",
        account_id="account-1",
        skill="send_text",
        params={"target": "@bot", "text": "/checkin"},
        secrets={"session_string": "secret-session"},
        retry=retry,
        timeout_seconds=30,
        retry_delay_seconds=0,
    )


class EngineTests(unittest.TestCase):
    def test_scheduled_run_waits_until_the_exact_second_before_execution(self):
        target = datetime(2026, 7, 18, 0, 1, 5, tzinfo=timezone.utc)
        current = target - timedelta(seconds=5)
        sleeps = []
        executions = []

        def sleep(seconds):
            nonlocal current
            sleeps.append(seconds)
            current += timedelta(seconds=seconds)

        base = make_spec(retry=0)
        spec = TaskSpec(
            **{field: getattr(base, field) for field in base.__dataclass_fields__ if field != "metadata"},
            metadata={"trigger": "cron", "scheduled_for": target.isoformat()},
        )
        result = Engine(
            FakeClient(),
            execute_skill=lambda _spec: executions.append(current) or {"data": {}, "logs": []},
            sleep=sleep,
            wall_clock=lambda: current,
        ).run(spec)

        self.assertEqual(sleeps, [5.0])
        self.assertEqual(executions, [target])
        self.assertEqual(result["schedule_lag_ms"], 0)
        self.assertEqual(result["schedule_wait_ms"], 5000)

    def test_retries_retryable_pre_send_failure_then_succeeds(self):
        calls = []

        def execute(_spec):
            calls.append(1)
            if len(calls) == 1:
                raise SkillExecutionError("network unavailable", retryable=True)
            return {"message_id": 42}

        client = FakeClient()
        result = Engine(client, execute_skill=execute, sleep=lambda _: None).run(make_spec())

        self.assertEqual(result["status"], "success")
        self.assertEqual(result["attempts"], 2)
        self.assertEqual(len(client.completions), 1)
        self.assertNotIn("secret-session", repr(result))

    def test_does_not_retry_ambiguous_failure(self):
        calls = []

        def execute(_spec):
            calls.append(1)
            raise SkillExecutionError(
                "connection dropped after send", retryable=True, ambiguous=True
            )

        result = Engine(FakeClient(), execute_skill=execute, sleep=lambda _: None).run(make_spec())

        self.assertEqual(result["status"], "ambiguous")
        self.assertEqual(result["attempts"], 1)
        self.assertTrue(result["error"]["ambiguous"])

    def test_timeout_is_ambiguous_and_not_retried(self):
        calls = []

        def execute(_spec):
            calls.append(1)
            raise SkillTimeout("timed out")

        result = Engine(FakeClient(), execute_skill=execute, sleep=lambda _: None).run(make_spec())

        self.assertEqual(result["attempts"], 1)
        self.assertEqual(result["error"]["code"], "timeout")

    def test_retry_uses_server_requested_flood_wait_delay(self):
        calls = []
        sleeps = []

        def execute(_spec):
            calls.append(1)
            if len(calls) == 1:
                raise SkillExecutionError(
                    "wait before retry",
                    code="flood_wait",
                    retryable=True,
                    ambiguous=False,
                    retry_after_seconds=17,
                )
            return {"data": {}, "logs": []}

        result = Engine(FakeClient(), execute_skill=execute, sleep=sleeps.append).run(make_spec())

        self.assertEqual(result["status"], "success")
        self.assertEqual(sleeps, [17])

    def test_session_is_sent_over_stdin_and_never_argv_or_environment(self):
        spec = make_spec(retry=0)
        process = mock.Mock()
        process.communicate.return_value = ('{"ok":true,"data":{},"logs":[]}', "")
        process.returncode = 0
        with mock.patch("runner.engine.subprocess.Popen", return_value=process) as popen:
            execute_in_subprocess(spec)

        command = popen.call_args.args[0]
        environment = popen.call_args.kwargs["env"]
        stdin_payload = process.communicate.call_args.args[0]
        self.assertNotIn("secret-session", repr(command))
        self.assertNotIn("secret-session", repr(environment))
        self.assertIn("secret-session", stdin_payload)


if __name__ == "__main__":
    unittest.main()
