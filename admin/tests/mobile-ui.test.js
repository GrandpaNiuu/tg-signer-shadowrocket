import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("mobile UI provides an app-like primary tab bar and safe-area layout", async () => {
  const [html, css] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../assets/styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(html, /class="mobile-tabbar"[^>]*aria-label="移动端主导航"/);
  for (const route of ["dashboard", "accounts", "tasks", "runs", "settings"]) {
    assert.match(html, new RegExp(`class="mobile-tabbar"[\\s\\S]*data-route="${route}"`));
  }
  assert.match(css, /env\(safe-area-inset-bottom/);
  assert.match(css, /\.mobile-tabbar\s*\{/);
  assert.match(css, /height:\s*100dvh/);
  assert.match(css, /font-size:\s*16px/);
});

test("mobile tables expose field labels for card rendering", async () => {
  const [app, css] = await Promise.all([
    readFile(new URL("../src/app.js", import.meta.url), "utf8"),
    readFile(new URL("../assets/styles.css", import.meta.url), "utf8"),
  ]);

  for (const label of ["账号", "连接状态", "任务", "下次执行", "执行状态", "登录方式"]) {
    assert.match(app, new RegExp(`data-label="${label}"`));
  }
  assert.match(css, /td::before\s*\{[^}]*content:\s*attr\(data-label\)/s);
});

test("dashboard recent runs use a dedicated compact mobile summary", async () => {
  const [app, css] = await Promise.all([
    readFile(new URL("../src/app.js", import.meta.url), "utf8"),
    readFile(new URL("../assets/styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(app, /function renderDashboardRecentRuns\(runs\)/);
  assert.match(app, /runs\.slice\(0,\s*3\)/);
  assert.match(app, /class="mobile-run-list"/);
  assert.match(css, /\.mobile-run-list\s*\{[^}]*display:\s*none/s);
  assert.match(css, /@media \(max-width:\s*760px\)[\s\S]*\.recent-runs-card \.table-wrap\s*\{[^}]*display:\s*none/s);
  assert.match(css, /@media \(max-width:\s*760px\)[\s\S]*\.mobile-run-list\s*\{[^}]*display:\s*grid/s);
});
