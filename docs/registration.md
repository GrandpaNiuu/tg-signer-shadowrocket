# 注册与登录状态

生产入口：`https://grandpaniu.ccwu.cc`

## 当前状态如何判断

仓库提供 `Live Authentication Audit` workflow。它会访问生产首页和 `/api/auth/config`，只记录以下非敏感状态：

- GitHub 登录/注册是否可用；
- 邮箱登录是否可用；
- 邮箱新注册是否开放；
- 邮箱验证、找回密码和 Turnstile 是否完整；
- 生产域名是否能正常打开。

该审计不会输出 OAuth Secret、密码 pepper、Turnstile Secret、Resend API Key、邮箱地址或用户数据。默认每天运行一次，也可以在 Actions 页面手动运行。手动运行时将 `require_email_registration` 设为 `true`，可以把“邮箱注册仍关闭”视为失败。

## 注册方式

### GitHub 注册

只要 GitHub OAuth 的 Client ID 与 Client Secret 已配置，首次使用 GitHub 登录就会自动创建独立用户工作区。该方式不依赖邮件服务。

### 邮箱注册

生产环境只允许经过验证的邮箱注册。以下五项必须同时存在：

1. GitHub Secret：`PASSWORD_PEPPER`；
2. GitHub Variable：`TURNSTILE_SITE_KEY`；
3. GitHub Secret：`TURNSTILE_SECRET_KEY`；
4. GitHub Secret：`RESEND_API_KEY`；
5. GitHub Variable：`AUTH_EMAIL_FROM`。

Turnstile Widget 的允许域名应包含 `grandpaniu.ccwu.cc`。`AUTH_EMAIL_FROM` 必须使用已在 Resend 验证的发件域名。

配置完成后运行 `Deploy Cloudflare Worker`，部署模式保持 `fresh_install`。部署 workflow 会执行以下检查：

- 四项邮箱安全配置不能只配置一部分；
- Worker `/health` 返回健康；
- Worker `/ready` 返回就绪；
- `/api/auth/config` 必须显示邮箱注册、邮箱验证、找回密码和 Turnstile 全部已启用。

最后手动运行 `Live Authentication Audit`，并将 `require_email_registration` 设为 `true`。审计通过后，生产注册页才应显示邮箱注册表单。

## 安全关闭状态

当 `PASSWORD_PEPPER` 已存在，但邮件服务或 Turnstile 未完整配置时：

- 已有邮箱用户仍可登录；
- 新邮箱注册关闭；
- 自助找回密码关闭；
- GitHub 登录与首次注册继续可用。

这是预期的 fail-closed 状态，不是数据库故障。前端会明确显示“GitHub 注册已开放”和“邮箱注册尚未开放”，不会再显示看起来可填写但实际上无法提交的邮箱注册表单。
