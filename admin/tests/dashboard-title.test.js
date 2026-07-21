import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const titleSourceUrl = new URL("../src/dashboard-title.js", import.meta.url);
const indexUrl = new URL("../index.html", import.meta.url);

test("dashboard uses a fixed product title instead of the signed-in user's name", async () => {
  const source = await readFile(titleSourceUrl, "utf8");
  assert.match(source, /const DASHBOARD_TITLE = "消息自动化控制台"/);
  assert.match(source, /title\.textContent !== DASHBOARD_TITLE/);
  assert.doesNotMatch(source, /identity-name|display_name|的工作区/);
});

test("dashboard unifies manual and scheduled runs in today's statistics", async () => {
  const source = await readFile(titleSourceUrl, "utf8");
  assert.match(source, /\/api\/v1\/task-runs\?limit=/);
  assert.match(source, /started_at \|\| run\?\.scheduled_for/);
  assert.match(source, /run\.trigger_type === "manual"/);
  assert.match(source, /run\.trigger_type !== "manual"/);
  assert.match(source, /手动 \$\{counts\.manual\} · 自动 \$\{counts\.automatic\}/);
  assert.match(source, /\["queued", "claimed", "running"\]/);
});

test("dashboard overview script is cache-busted and loaded after profile branding", async () => {
  const html = await readFile(indexUrl, "utf8");
  const profileIndex = html.indexOf("/src/profile-branding.js");
  const titleIndex = html.indexOf("/src/dashboard-title.js?v=20260722-2");
  assert.ok(profileIndex >= 0);
  assert.ok(titleIndex > profileIndex);
});
