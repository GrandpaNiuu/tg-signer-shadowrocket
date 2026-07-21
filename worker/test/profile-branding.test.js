import assert from "node:assert/strict";
import test from "node:test";

import { __test } from "../src/profile-branding-api.js";

function tinyImage(type = "png") {
  return `data:image/${type};base64,${btoa("avatar")}`;
}

test("profile avatars accept only safe raster data URLs", () => {
  assert.equal(__test.imageDataUrl(tinyImage("png"), "avatar"), tinyImage("png"));
  assert.equal(__test.imageDataUrl(tinyImage("jpeg"), "avatar"), tinyImage("jpeg"));
  assert.equal(__test.imageDataUrl(null, "avatar"), null);
  assert.throws(
    () => __test.imageDataUrl("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", "avatar"),
    (error) => error?.code === "validation_failed",
  );
});

test("profile avatars reject payloads larger than the storage limit", () => {
  const oversized = `data:image/png;base64,${btoa("x".repeat(300_001))}`;
  assert.throws(
    () => __test.imageDataUrl(oversized, "avatar"),
    (error) => error?.code === "validation_failed",
  );
});

test("branding snapshots fall back safely when stored JSON is invalid", () => {
  assert.deepEqual(__test.safeBranding("not-json"), {
    platform_name: "Telegram 自动消息",
    platform_avatar_data_url: null,
  });
  assert.deepEqual(__test.safeBranding(JSON.stringify({
    platform_name: "Grandpa Niu",
    platform_avatar_data_url: tinyImage("webp"),
  })), {
    platform_name: "Grandpa Niu",
    platform_avatar_data_url: tinyImage("webp"),
  });
});

test("display names and platform names are length limited", () => {
  assert.equal(__test.text(" Grandpa Niu ", "display_name", { maximum: 40 }), "Grandpa Niu");
  assert.throws(
    () => __test.text("x".repeat(41), "display_name", { maximum: 40 }),
    (error) => error?.code === "validation_failed",
  );
});
