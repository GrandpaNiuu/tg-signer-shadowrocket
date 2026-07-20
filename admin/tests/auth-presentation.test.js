import assert from "node:assert/strict";
import test from "node:test";

import {
  githubButtonLabel,
  loginSecurityMessage,
  registrationPresentation,
  turnstileActionForMode,
} from "../src/auth-presentation.js";

test("GitHub calls to action distinguish login from registration", () => {
  assert.equal(githubButtonLabel("login"), "使用 GitHub 登录");
  assert.equal(githubButtonLabel("register"), "使用 GitHub 注册");
});

test("Turnstile actions stay bound to the active authentication flow", () => {
  assert.equal(turnstileActionForMode("login"), "email_login");
  assert.equal(turnstileActionForMode("register"), "email_register");
  assert.equal(turnstileActionForMode("forgot-password"), "forgot_password");
  assert.equal(turnstileActionForMode("reset-password"), "reset_password");
  assert.equal(turnstileActionForMode("unknown"), "email_login");
});

test("current production state is presented as GitHub registration, not a broken email form", () => {
  const presentation = registrationPresentation({
    github_enabled: true,
    email_enabled: true,
    registration_enabled: false,
    email_verification_required: false,
    password_reset_enabled: false,
    security_setup_required: true,
    turnstile_site_key: null,
  });
  assert.deepEqual(presentation, {
    state: "github-only",
    showEmailDivider: false,
    title: "GitHub 注册已开放",
    message: "邮箱新注册尚未开放；已有邮箱账号仍可返回登录。",
  });
});

test("verified email registration is shown only when every public security feature is ready", () => {
  const presentation = registrationPresentation({
    github_enabled: true,
    email_enabled: true,
    registration_enabled: true,
    email_verification_required: true,
    password_reset_enabled: true,
    turnstile_site_key: "site-key",
  });
  assert.equal(presentation.state, "open");
  assert.equal(presentation.showEmailDivider, true);
  assert.match(presentation.message, /人机验证和邮件确认/);
});

test("login warning accurately separates existing email access from new registration", () => {
  assert.equal(loginSecurityMessage({
    email_enabled: true,
    security_setup_required: true,
  }), "已有邮箱账号可以继续登录；邮箱新注册和自助找回密码尚未完成安全配置。");
  assert.equal(loginSecurityMessage({ email_enabled: false }), null);
});
