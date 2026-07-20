import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const taskUrl = new URL("../.github/workflows/task-runner.yml", import.meta.url);
const loginUrl = new URL("../.github/workflows/telegram-login.yml", import.meta.url);
const actionUrl = new URL("../.github/actions/resolve-worker-config/action.yml", import.meta.url);

async function read(url) {
  return readFile(url, "utf8");
}

for (const [name, url, idName] of [
  ["task", taskUrl, "run_id"],
  ["login", loginUrl, "flow_id"],
]) {
  test(`${name} workflow resolves Worker configuration before dependency installation`, async () => {
    const content = await read(url);
    const setup = content.indexOf("- name: Set up Python");
    const resolve = content.indexOf("- name: Resolve Worker configuration");
    const install = content.indexOf("- name: Install pinned Telegram dependency");
    assert.ok(setup >= 0);
    assert.ok(resolve > setup);
    assert.ok(install > resolve);
    assert.match(content, /uses: \.\/\.github\/actions\/resolve-worker-config/);
    assert.match(content, /secrets\.WORKER_URL \|\| vars\.WORKER_URL/);
    assert.match(content, /secrets\.WORKER_OIDC_AUDIENCE \|\| vars\.WORKER_OIDC_AUDIENCE/);
    assert.match(content, new RegExp(`Invalid ${idName} format\\.`));
  });
}

test("shared action derives either endpoint and rejects inconsistent audiences", async () => {
  const content = await read(actionUrl);
  assert.match(content, /audience\.endswith\("\/api\/runner"\)/);
  assert.match(content, /audience = f"\{worker_url\}\/api\/runner"/);
  assert.match(content, /parsed\.scheme != "https"/);
  assert.match(content, /parsed\.path not in \{"", "\/"\}/);
  assert.match(content, /audience != expected_audience/);
  assert.match(content, /GITHUB_ENV/);
});

test("terminal callbacks run after execution but not after invalid setup", async () => {
  const task = await read(taskUrl);
  const login = await read(loginUrl);
  assert.ok(task.indexOf("- name: Ensure terminal callback") < task.indexOf("- name: Reflect task outcome in Actions"));
  assert.ok(login.indexOf("- name: Ensure failed/interrupted login is recorded") < login.indexOf("- name: Reflect login outcome in Actions"));

  for (const content of [task, login]) {
    assert.equal((content.match(/always\(\)/g) || []).length, 2);
    assert.equal((content.match(/steps\.resolve_worker\.outcome == 'success'/g) || []).length, 2);
    assert.equal((content.match(/steps\.validate_id\.outcome == 'success'/g) || []).length, 2);
    assert.equal((content.match(/steps\.install_dependency\.outcome == 'success'/g) || []).length, 2);
  }
});
