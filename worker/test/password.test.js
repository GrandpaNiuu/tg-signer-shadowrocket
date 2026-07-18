import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { __test } from "../src/password.js";

test("password hashing defaults to the Worker free-tier compatible iteration count", () => {
  assert.equal(__test.iterationsFromEnv({}), 100000);
  assert.equal(__test.iterationsFromEnv({ PASSWORD_HASH_ITERATIONS: "invalid" }), 100000);
});

test("password hashing accepts a configured iteration count within the supported range", () => {
  assert.equal(__test.iterationsFromEnv({ PASSWORD_HASH_ITERATIONS: "200000" }), 200000);
});

test("production Wrangler configuration uses the Worker-compatible iteration count", async () => {
  const wrangler = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.match(wrangler, /^PASSWORD_HASH_ITERATIONS = "100000"$/m);
});
