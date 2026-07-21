import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const profile = await readFile(new URL("../src/profile-branding.js", import.meta.url), "utf8");
const cropper = await readFile(new URL("../src/avatar-cropper.js", import.meta.url), "utf8");
const status = await readFile(new URL("../src/profile-branding-status.js", import.meta.url), "utf8");

test("all signed-in users get a manual avatar editor", () => {
  assert.match(profile, /每个用户都可以自由修改自己的用户名和头像/);
  assert.match(profile, /openAvatarCropper/);
  assert.match(cropper, /pointerdown/);
  assert.match(cropper, /data-crop-zoom/);
  assert.match(cropper, /使用此头像/);
});

test("the status helper does not consume avatar file changes", () => {
  assert.doesNotMatch(status, /stopImmediatePropagation/);
  assert.doesNotMatch(status, /document\.addEventListener\("change"/);
});
