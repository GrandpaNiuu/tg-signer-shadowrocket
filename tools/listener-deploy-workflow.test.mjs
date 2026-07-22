import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../.github/workflows/deploy-listener.yml", import.meta.url);
const serviceUrl = new URL("../listener/service.py", import.meta.url);
const versionUrl = new URL("../listener/__init__.py", import.meta.url);

test("Listener runtime is automatically deployed after relevant main changes", async () => {
  const source = await readFile(workflowUrl, "utf8");
  assert.match(source, /push:\s*\n\s*branches:\s*\n\s*-\s*"main"/);
  assert.match(source, /-\s*"listener\/\*\*"/);
  assert.match(source, /-\s*"runner\/\*\*"/);
  assert.match(source, /LISTENER_INSTANCE_ID:\s*\$\{\{\s*inputs\.instance_id\s*\|\|\s*vars\.LISTENER_INSTANCE_ID\s*\|\|\s*'listener-vps-1'\s*\}\}/);
  assert.match(source, /LISTENER_LABEL:\s*\$\{\{\s*inputs\.listener_label\s*\|\|\s*vars\.LISTENER_LABEL\s*\|\|\s*'Telegram Listener VPS'\s*\}\}/);
  assert.match(source, /"LISTENER_TASK_SECONDS":\s*"2"/);
  assert.match(source, /-czf[\s\S]*source\.tar\.gz[\s\S]*listener runner/);
});

test("deployed Listener owns realtime-account scheduled execution", async () => {
  const source = await readFile(serviceUrl, "utf8");
  assert.match(source, /async def task_loop\(self\)/);
  assert.match(source, /claim = await self\.worker\.claim_task\(self\.instance_id\)/);
  assert.match(source, /managed = self\.manager\.accounts\.pop\(account_id, None\)/);
  assert.match(source, /await stop_client\(managed\.client\)/);
  assert.match(source, /await asyncio\.to_thread\(execute_claimed_task/);
  assert.match(source, /self\.manager\.accounts\[account_id\] = ManagedAccount/);
  assert.match(source, /asyncio\.create_task\(self\.task_loop\(\)\)/);
});

test("Listener heartbeat exposes the readable-event runtime version", async () => {
  const source = await readFile(versionUrl, "utf8");
  assert.match(source, /__version__\s*=\s*"0\.3\.0"/);
});
