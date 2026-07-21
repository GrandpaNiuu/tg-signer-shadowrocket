import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { handleProfileBrandingApi, __test } from "../src/profile-branding.js";

const migrationUrl = new URL("../migrations/0103_profile_branding.sql", import.meta.url);
const tinyPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlPTxQAAAAASUVORK5CYII=";

test("profile branding migration adds avatar storage and global settings", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /ALTER TABLE users ADD COLUMN avatar_data_url TEXT/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS platform_settings/);
  assert.match(sql, /updated_by TEXT REFERENCES users\(id\)/);
});

test("display names are normalized and constrained", () => {
  assert.equal(__test.normalizeDisplayName("  Grandpa   Niu  "), "Grandpa Niu");
  assert.throws(() => __test.normalizeDisplayName(""), /用户名需要填写/);
  assert.throws(() => __test.normalizeDisplayName("a".repeat(61)), /用户名需要填写/);
});

test("avatar validation accepts real raster data and rejects unsafe formats", () => {
  assert.equal(__test.normalizeAvatar(tinyPng, "avatar_data_url"), tinyPng);
  assert.equal(__test.normalizeAvatar(null, "avatar_data_url"), null);
  assert.throws(
    () => __test.normalizeAvatar("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", "avatar_data_url"),
    /只支持 PNG、JPEG 或 WebP/,
  );
  assert.throws(
    () => __test.normalizeAvatar(`data:image/png;base64,${"A".repeat(132_000)}`, "avatar_data_url"),
    /小于 96 KB|无效或过大/,
  );
});

test("ordinary users cannot modify platform branding", async () => {
  const request = new Request("https://worker.example/api/v1/admin/platform-branding", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ avatar_data_url: null }),
  });
  await assert.rejects(
    () => handleProfileBrandingApi(request, { db: {} }, {
      identity: { user_id: "user-1", role: "user" },
      now: () => new Date("2026-07-21T00:00:00.000Z"),
    }),
    (error) => error?.status === 403 && error?.code === "administrator_required",
  );
});
