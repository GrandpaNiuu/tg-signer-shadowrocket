import assert from "node:assert/strict";
import test from "node:test";

import {
  __test,
  handlePlatformAccountHealthApi,
} from "../src/platform-account-health.js";

test("platform account health list options stay bounded", () => {
  const parsed = __test.listOptions(new URL("https://example.test/api/v1/admin/account-health?limit=20&cursor=40"));
  assert.deepEqual(parsed, { limit: 20, offset: 40 });
  assert.throws(
    () => __test.listOptions(new URL("https://example.test/api/v1/admin/account-health?limit=101")),
    /分页参数无效/,
  );
});

test("platform account health responses expose only support-safe account metadata", () => {
  const mapped = __test.mapHealthRow({
    id: "account-1",
    user_id: "user-1",
    owner_display_name: "User",
    owner_email: "user@example.test",
    account_name: "Telegram 账号",
    phone_masked: "+86****1234",
    status: "error",
    enabled: 1,
    session_configured: 1,
    last_error: "AUTH_KEY_UNREGISTERED",
    created_at: "2026-07-21T00:00:00.000Z",
    updated_at: "2026-07-21T00:00:00.000Z",
    session_secret_id: "must-not-leak",
    proxy_secret_id: "must-not-leak",
  });
  assert.equal(mapped.owner_login, "user@example.test");
  assert.equal(mapped.phone_masked, "+86****1234");
  assert.equal(mapped.session_configured, true);
  assert.equal("session_secret_id" in mapped, false);
  assert.equal("proxy_secret_id" in mapped, false);
});

test("batch validation accepts at most twenty unique account ids", () => {
  assert.deepEqual(__test.batchAccountIds({ account_ids: ["a", "a", "b"] }), ["a", "b"]);
  assert.throws(
    () => __test.batchAccountIds({ account_ids: Array.from({ length: 21 }, (_, index) => `a-${index}`) }),
    /1 至 20/,
  );
});

test("ordinary users cannot access platform account health routes", async () => {
  await assert.rejects(
    () => handlePlatformAccountHealthApi(
      new Request("https://example.test/api/v1/admin/account-health"),
      {},
      {},
      { identity: { role: "user" } },
    ),
    (error) => error?.status === 403 && error?.code === "administrator_required",
  );
});
