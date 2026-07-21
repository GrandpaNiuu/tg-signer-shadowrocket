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

test("dashboard title override is loaded after profile branding", async () => {
  const html = await readFile(indexUrl, "utf8");
  const profileIndex = html.indexOf("/src/profile-branding.js");
  const titleIndex = html.indexOf("/src/dashboard-title.js");
  assert.ok(profileIndex >= 0);
  assert.ok(titleIndex > profileIndex);
});
