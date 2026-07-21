import assert from "node:assert/strict";
import test from "node:test";

import {
  runLiveProfileAudit,
  validateProtectedProfile,
  validatePublicBranding,
} from "./live-profile-audit.mjs";

function result(status, payload) {
  return { status, payload };
}

test("public branding accepts a nullable avatar", () => {
  assert.equal(validatePublicBranding(result(200, { data: { avatar_data_url: null } })), "ok");
  assert.throws(() => validatePublicBranding(result(503, { error: {} })), /unavailable/);
});

test("protected profile must exist and reject anonymous requests", () => {
  assert.equal(validateProtectedProfile(result(401, {
    error: { code: "authentication_required" },
  })), "protected");
  assert.throws(() => validateProtectedProfile(result(404, {
    error: { code: "not_found" },
  })), /missing from the deployed Worker/);
  assert.throws(() => validateProtectedProfile(result(500, {
    error: { code: "internal_error" },
  })), /reached the Worker but failed/);
  assert.throws(() => validateProtectedProfile(result(200, {
    data: { profile: null },
  })), /unexpected response/);
});

test("live audit checks the Pages service binding and Worker routes", async () => {
  const responses = new Map([
    ["/api/auth/config", [200, { data: { github_enabled: true } }]],
    ["/api/branding", [200, { data: { avatar_data_url: null } }]],
    ["/api/v1/profile", [401, { error: { code: "authentication_required" } }]],
  ]);
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    const [status, payload] = responses.get(parsed.pathname);
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  const audit = await runLiveProfileAudit({ adminUrl: "https://admin.example", fetchImpl });
  assert.deepEqual(audit, {
    admin_origin: "https://admin.example",
    service_binding: "ok",
    public_branding: "ok",
    protected_profile: "protected",
    profile_status: 401,
    profile_error_code: "authentication_required",
  });
});
