import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const mergeUrl = new URL("../src/signer-skill-merge.js", import.meta.url);
const hubUrl = new URL("../src/automation-skill-hub.js", import.meta.url);
const indexUrl = new URL("../index.html", import.meta.url);

test("merged signer Skill JavaScript passes syntax validation", () => {
  const result = spawnSync(process.execPath, ["--check", fileURLToPath(mergeUrl)], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("bot inspection is presented as a signer creation method instead of a separate visible Skill", async () => {
  const [source, hub] = await Promise.all([readFile(mergeUrl, "utf8"), readFile(hubUrl, "utf8")]);
  assert.doesNotMatch(hub, /bot_inspection/);
  assert.match(source, /自动识别并创建（推荐）/);
  assert.match(source, /手动配置/);
  assert.match(source, /data-signer-skill-action/);
});

test("inspection controls are limited to the tg_signer task form", async () => {
  const source = await readFile(mergeUrl, "utf8");
  assert.match(source, /select\.value === "tg_signer"/);
  assert.match(source, /controls\.hidden = !signerSelected/);
  assert.match(source, /开始识别机器人/);
});

test("production shell loads signer merge after the Skill hub", async () => {
  const html = await readFile(indexUrl, "utf8");
  const hub = html.indexOf("/src/automation-skill-hub.js");
  const merge = html.indexOf("/src/signer-skill-merge.js");
  assert.ok(hub > 0 && merge > hub);
});
