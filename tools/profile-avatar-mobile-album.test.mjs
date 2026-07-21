import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceUrl = new URL("../admin/src/profile-branding-status.js", import.meta.url);

async function source() {
  return readFile(sourceUrl, "utf8");
}

test("avatar picker accepts mobile album images and normalizes them safely", async () => {
  const content = await source();
  assert.match(content, /accept\", \"image\/\*,\.heic,\.heif/);
  assert.match(content, /createImageBitmap/);
  assert.match(content, /imageOrientation: \"from-image\"/);
  assert.match(content, /telegram-avatar\.jpg/);
  assert.match(content, /从手机相册选择/);
  assert.match(content, /自动居中裁剪和压缩/);
});

test("avatar DOM synchronization is idempotent and cannot retrigger its observer", async () => {
  const content = await source();
  assert.match(content, /button\.textContent !== ALBUM_PICKER_LABEL/);
  assert.match(content, /paragraph\.textContent !== ALBUM_HELP_TEXT/);
  assert.match(content, /input\.getAttribute\("accept"\) !== "image\/\*,\.heic,\.heif"/);
  assert.match(content, /\.observe\(view, \{ childList: true \}\)/);
  assert.doesNotMatch(content, /childList: true, subtree: true/);
});
