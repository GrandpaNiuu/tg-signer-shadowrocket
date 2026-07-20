from __future__ import annotations

import asyncio
import logging
import os
import signal
import socket

from listener.service import ListenerService
from listener.worker_client import ListenerWorkerClient


def required_environment() -> tuple[str, str]:
    worker_url = os.environ.get("WORKER_URL", "").strip().rstrip("/")
    token = os.environ.get("LISTENER_API_TOKEN", "").strip()
    if not worker_url.startswith("https://") and os.environ.get("ALLOW_INSECURE_HTTP") != "true":
        raise RuntimeError("WORKER_URL must use HTTPS")
    if len(token) < 32:
        raise RuntimeError("LISTENER_API_TOKEN must contain at least 32 characters")
    return worker_url, token


async def run() -> None:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    worker_url, token = required_environment()
    instance_id = os.environ.get("LISTENER_INSTANCE_ID", socket.gethostname()).strip()
    label = os.environ.get("LISTENER_LABEL", instance_id).strip()
    service = ListenerService(
        ListenerWorkerClient(worker_url, token),
        instance_id=instance_id,
        label=label,
        sync_interval=max(10, int(os.environ.get("LISTENER_SYNC_SECONDS", "30"))),
        heartbeat_interval=max(20, int(os.environ.get("LISTENER_HEARTBEAT_SECONDS", "60"))),
        inspection_interval=max(2, int(os.environ.get("LISTENER_INSPECTION_SECONDS", "4"))),
    )
    loop = asyncio.get_running_loop()
    for signal_name in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(signal_name, service.stop_event.set)
        except NotImplementedError:
            pass
    await service.run()


if __name__ == "__main__":
    asyncio.run(run())
