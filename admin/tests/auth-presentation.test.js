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
    message: "邮箱新注册暂未开放；已有邮箱账号可以返回登录，或使用 GitHub 创建账号。",
  });
});

test("verified email registration explains capabilities and verification requirements", () => {
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
  assert.match(presentation.message, /独立管理定时消息、机器人操作和执行记录/);
  assert.match(presentation.message, /人机验证和 6 位邮件验证码/);
});

test("login guidance uses user-facing instructions instead of configuration status", () => {
  assert.equal(loginSecurityMessage({
    email_enabled: true,
    security_setup_required: true,
  }), "已有邮箱账号可以继续登录；邮箱新注册和密码找回暂未开放。");
  assert.equal(loginSecurityMessage({
    email_enabled: true,
    registration_enabled: true,
    email_verification_required: true,
    password_reset_enabled: true,
  }), "输入注册邮箱和密码，并完成人机验证。连续多次失败后，系统会暂时限制尝试。");
  assert.equal(loginSecurityMessage({ email_enabled: false }), null);
});
