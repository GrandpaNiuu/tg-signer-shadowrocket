import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

for (const relativePath of [
  "../admin/src/avatar-cropper.js",
  "../admin/src/profile-branding.js",
  "../admin/src/profile-branding-status.js",
]) {
  test(`avatar module remains parseable: ${relativePath}`, async () => {
    const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
    if (relativePath.endsWith("profile-branding.js")) {
      assert.match(source, /^import \{ openAvatarCropper \}/);
      assert.match(source, /globalThis\.__telegramProfileBrandingLoaded/);
      return;
    }
    if (relativePath.endsWith("avatar-cropper.js")) {
      assert.match(source, /export async function openAvatarCropper/);
      return;
    }
    new vm.Script(source);
  });
}
