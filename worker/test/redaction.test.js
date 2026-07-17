import assert from "node:assert/strict";
import test from "node:test";

import { redact, sanitizeLogText } from "../src/redaction.js";

test("structured redaction removes every configured secret field recursively", () => {
  assert.deepEqual(redact({
    api_hash: "hash-secret",
    session: "session-secret",
    nested: {
      proxy_password: "proxy-secret",
      code: "12345",
      two_factor_password: "2fa-secret",
      command: "/checkin",
    },
  }), {
    api_hash: "[REDACTED]",
    session: "[REDACTED]",
    nested: {
      proxy_password: "[REDACTED]",
      code: "[REDACTED]",
      two_factor_password: "[REDACTED]",
      command: "/checkin",
    },
  });
});

test("free-form logs redact assignments, bearer tokens, and proxy URL credentials", () => {
  const source = "API_HASH=abc123 Authorization: Bearer gh-token proxy=http://user:pass@example.com:8080 code: 98231 client_secret=oauth-value";
  const result = sanitizeLogText(source);

  assert.equal(result.includes("abc123"), false);
  assert.equal(result.includes("gh-token"), false);
  assert.equal(result.includes(":pass@"), false);
  assert.equal(result.includes("98231"), false);
  assert.equal(result.includes("oauth-value"), false);
  assert.match(result, /\[REDACTED\]/);
});

test("log sanitizer bounds line count and total length", () => {
  const source = Array.from({ length: 300 }, (_, index) => `${index}:${"x".repeat(100)}`).join("\n");
  const result = sanitizeLogText(source, { maxLines: 20, maxLength: 500 });

  assert.ok(result.length <= 500);
  assert.ok(result.split("\n").length <= 20);
});
