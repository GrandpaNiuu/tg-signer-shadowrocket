import assert from "node:assert/strict";
import test from "node:test";

import { decryptSecret, encryptSecret } from "../src/crypto.js";

const ROOT_KEY = Buffer.alloc(32, 7).toString("base64");

test("AES-256-GCM secret round-trips with purpose-bound AAD", async () => {
  const encrypted = await encryptSecret(ROOT_KEY, "sensitive-session", {
    purpose: "telegram_session",
    ownerId: "account-1",
    keyVersion: 3,
  });

  assert.equal(encrypted.key_version, 3);
  assert.notEqual(encrypted.ciphertext, "sensitive-session");
  assert.equal(Buffer.from(encrypted.nonce, "base64").length, 12);
  assert.equal(
    await decryptSecret(ROOT_KEY, encrypted, {
      purpose: "telegram_session",
      ownerId: "account-1",
    }),
    "sensitive-session",
  );
});

test("AES-GCM rejects ciphertext under a different owner or purpose", async () => {
  const encrypted = await encryptSecret(ROOT_KEY, "secret", {
    purpose: "api_hash",
    ownerId: "account-1",
  });

  await assert.rejects(
    decryptSecret(ROOT_KEY, encrypted, { purpose: "api_hash", ownerId: "account-2" }),
  );
});

test("root key must be exactly 32 bytes", async () => {
  await assert.rejects(
    encryptSecret(Buffer.alloc(16).toString("base64"), "secret", {
      purpose: "api_hash",
      ownerId: "account-1",
    }),
    /32-byte/,
  );
});
