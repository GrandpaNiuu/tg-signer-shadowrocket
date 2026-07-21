import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const profileUrl = new URL("../admin/src/profile-branding.js", import.meta.url);
const cropperUrl = new URL("../admin/src/avatar-cropper.js", import.meta.url);
const statusUrl = new URL("../admin/src/profile-branding-status.js", import.meta.url);
const shellUrl = new URL("../admin/src/mobile-shell-v2.js", import.meta.url);
const indexUrl = new URL("../admin/index.html", import.meta.url);

async function source(url) {
  return readFile(url, "utf8");
}

test("every user can choose an album image and manually crop the avatar", async () => {
  const profile = await source(profileUrl);
  const cropper = await source(cropperUrl);
  assert.match(profile, /每个用户都可以自由修改自己的用户名和头像/);
  assert.match(profile, /accept="image\/\*,\.heic,\.heif"/);
  assert.match(profile, /openAvatarCropper/);
  assert.match(profile, /选择并裁剪头像/);
  assert.match(cropper, /createImageBitmap/);
  assert.match(cropper, /imageOrientation: "from-image"/);
  assert.match(cropper, /pointerdown/);
  assert.match(cropper, /data-crop-zoom/);
  assert.match(cropper, /使用此头像/);
  assert.match(cropper, /拖动照片调整位置/);
});

test("album input synchronization is passive and cannot consume the selected file", async () => {
  const status = await source(statusUrl);
  assert.match(status, /input\.getAttribute\("accept"\) !== "image\/\*,\.heic,\.heif"/);
  assert.doesNotMatch(status, /document\.addEventListener\("change"/);
  assert.doesNotMatch(status, /stopImmediatePropagation/);
  assert.match(status, /\.observe\(view, \{ childList: true \}\)/);
  assert.doesNotMatch(status, /childList: true, subtree: true/);
});

test("profile branding is loaded once instead of being imported by the mobile shell twice", async () => {
  const shell = await source(shellUrl);
  const index = await source(indexUrl);
  assert.doesNotMatch(shell, /profile-branding/);
  assert.equal((index.match(/src="\/src\/profile-branding\.js/g) || []).length, 1);
  assert.equal((index.match(/src="\/src\/profile-branding-status\.js/g) || []).length, 1);
});
