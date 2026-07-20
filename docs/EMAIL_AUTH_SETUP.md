# 邮箱验证、Turnstile 与找回密码配置

生产 Worker 使用 `PUBLIC_PASSWORD_AUTH_MODE = "secure"`。在邮件和人机验证基础设施未完整配置时：

- 已存在的邮箱用户可以继续登录；
- GitHub 登录继续可用；
- 新的邮箱注册关闭；
- 找回密码关闭；
- 不会退回到“注册后直接激活”的无验证模式。

只有下面四项全部配置后，部署流程才会同时开放邮箱注册、邮箱验证、人机验证和找回密码。

## 需要配置的 GitHub 值

在仓库 Settings → Secrets and variables → Actions 中配置：

| 类型 | 名称 | 用途 |
|---|---|---|
| Repository Variable | `TURNSTILE_SITE_KEY` | Cloudflare Turnstile 公开 Site Key |
| Repository Secret | `TURNSTILE_SECRET_KEY` | Turnstile 服务端校验 Secret |
| Repository Variable | `AUTH_EMAIL_FROM` | 已验证的发件人，例如 `Telegram 自动消息 <login@example.com>` |
| Repository Secret | `RESEND_API_KEY` | Resend 邮件发送 API Key |

四项必须全部存在。只配置其中一部分时，Worker 部署会失败并列出缺失的名称，避免出现“页面显示验证码但邮件发不出去”等半启用状态。

## Cloudflare Turnstile

1. 在 Cloudflare 创建 Turnstile Widget。
2. 允许的生产域名填写 `grandpaniu.ccwu.cc`。
3. 将 Site Key 保存为 GitHub Repository Variable `TURNSTILE_SITE_KEY`。
4. 将 Secret Key 保存为 GitHub Repository Secret `TURNSTILE_SECRET_KEY`。
5. 不要把 Secret Key 写入 `wrangler.toml`、README、Issue 或日志。

## Resend 邮件

1. 在 Resend 验证发件域名或发件地址。
2. 创建只用于本项目的 API Key。
3. 将 API Key 保存为 GitHub Repository Secret `RESEND_API_KEY`。
4. 将完整发件人保存为 GitHub Repository Variable `AUTH_EMAIL_FROM`。
5. 发件人必须属于 Resend 已验证的域名，否则验证邮件和重置邮件会发送失败。

## 部署与验证

完成四项配置后，手动运行 `Deploy Cloudflare Worker`，模式选择 `fresh_install`。

工作流会自动执行：

1. 检查四项是否全部配置；
2. 生成仅在 Runner 临时目录存在的部署配置和 Secret JSON；
3. 应用 D1 migrations；
4. 部署 Worker；
5. 检查 `/health` 与 `/ready`；
6. 检查 `/api/auth/config`，确认：
   - `registration_enabled = true`；
   - `email_verification_required = true`；
   - `password_reset_enabled = true`；
   - 返回的 Turnstile Site Key 与 GitHub Variable 一致；
7. 无论成功或失败都删除临时 Secret 文件。

## 已有邮箱用户的迁移

旧的本地模式用户可能处于 `active`，但 `email_verified_at` 为空。

启用完整安全配置后：

1. 用户输入原邮箱和正确密码；
2. 系统拒绝直接登录并发送验证邮件；
3. 用户点击任意仍在 24 小时有效期内的验证链接；
4. 系统写入 `email_verified_at` 并清理其余验证链接；
5. 用户重新登录；
6. 此后可以使用“忘记密码”。

登录动作生成的新验证邮件不会立即使之前仍有效的验证邮件失效。

## 找回密码流程

找回密码只向已完成邮箱验证且状态为 `active` 的账号发送邮件。接口始终返回统一结果，不会向调用者暴露邮箱是否存在。

重置链接：

- 30 分钟后过期；
- 只能使用一次；
- 成功重置后撤销该用户的全部旧浏览器会话；
- 新密码仍执行 PBKDF2 哈希和 Pepper 保护；
- Turnstile 校验和频率限制同时生效。

## 回滚

如邮件服务或 Turnstile 暂时不可用，可删除或暂时移除这四项配置后重新部署。

安全回滚结果是：

- 已有邮箱用户仍可登录；
- 新邮箱注册和找回密码关闭；
- GitHub 登录继续可用；
- 不会开放免验证注册。
