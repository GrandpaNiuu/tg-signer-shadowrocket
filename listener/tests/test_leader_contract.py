from __future__ import annotations

import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]


class ListenerLeaderContractTests(unittest.TestCase):
    def test_worker_client_sends_instance_identity(self) -> None:
        source = (ROOT / "listener" / "worker_client.py").read_text(encoding="utf-8")
        self.assertIn('headers["x-listener-instance-id"] = self.instance_id', source)
        self.assertIn('"leader": False', source)

    def test_standby_instances_do_not_claim_inspections(self) -> None:
        source = (ROOT / "listener" / "service.py").read_text(encoding="utf-8")
        self.assertIn("self.is_leader = False", source)
        self.assertIn('self.is_leader = config.get("leader") is not False', source)
        leader_check = source.index("if not self.is_leader:")
        claim = source.index("job = await self.worker.claim_inspection")
        self.assertLess(leader_check, claim)

    def test_entrypoint_binds_client_to_configured_instance(self) -> None:
        source = (ROOT / "listener" / "__main__.py").read_text(encoding="utf-8")
        self.assertIn("ListenerWorkerClient(worker_url, token, instance_id=instance_id)", source)


if __name__ == "__main__":
    unittest.main()
