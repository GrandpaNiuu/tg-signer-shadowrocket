# 邮箱验证码、Turnstile 与找回密码配置

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

1. 在 Resend 添加并验证自己可控制 DNS 的发件域名。
2. 创建只用于本项目的 API Key。
3. 将 API Key 保存为 GitHub Repository Secret `RESEND_API_KEY`。
4. 将完整发件人保存为 GitHub Repository Variable `AUTH_EMAIL_FROM`。
5. 发件人域名必须与 Resend 中显示为已验证的域名完全一致，包括子域名。
6. `onboarding@resend.dev` 和其他 `resend.dev` 地址仅用于测试，不能用于公开注册；程序会主动关闭该配置下的新注册和密码找回。

示例：如果 Resend 验证的是 `send.example.com`，应设置：

```text
AUTH_EMAIL_FROM=Telegram 自动消息 <login@send.example.com>
```

不能设置成 `login@example.com`，因为根域名和已验证子域名并不是同一个发件域名。

## 邮箱注册验证码流程

1. 用户填写显示名称、邮箱、密码并完成 Turnstile。
2. Worker 创建 `pending` 用户并发送 6 位数字验证码。
3. 验证码只在邮件中出现，D1 仅保存与用户 ID、`PASSWORD_PEPPER` 绑定后的哈希。
4. 验证码 10 分钟后失效，最多允许连续尝试 5 次。
5. 重新发送至少间隔 60 秒；同一邮箱每小时最多发送 5 次。
6. 重新发送后旧验证码和旧备用验证链接立即失效。
7. 验证成功后账号变为 `active` 并写入 `email_verified_at`。
8. 同一邮箱不能重复注册；未验证账号应返回登录，使用首次设置的密码继续验证。

验证码邮件同时发送 HTML 和纯文本内容，并保留一次性备用验证链接。主注册界面默认要求输入 6 位验证码。

## 收不到验证码时排查

按以下顺序检查：

1. 在 Resend → Emails 中搜索收件邮箱，查看状态是 `sent`、`delivered`、`bounced`、`failed`、`suppressed` 还是 `delivery_delayed`。
2. 如果根本没有邮件记录，检查 Worker 日志中的 `transactional_email_delivery_failed`；错误会区分 API Key、发件域名、限流、网络或服务异常。
3. 如果日志出现 `transactional_email_accepted`，可用其中的 `provider_id` 在 Resend 中定位具体邮件。
4. 检查 `AUTH_EMAIL_FROM` 的域名是否与 Resend 已验证域名完全一致。
5. 检查发件域名的 SPF、DKIM，建议同时配置 DMARC。
6. 检查 Gmail 的垃圾邮件、推广、所有邮件、过滤器和已删除邮件。
7. 被 Resend suppression list 抑制的地址需要先从 suppression list 中移除，再重新发送。

页面只有在 Resend 接口明确接受发送请求后才会显示验证码已发送；若提供商拒绝，页面会显示可操作的配置错误，不再统一显示模糊的“发送失败”。

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
2. 系统拒绝直接登录并提示完成邮箱验证码验证；
3. 系统向原邮箱重新发送 6 位验证码；
4. 验证成功后系统写入 `email_verified_at` 并清理其余验证凭据；
5. 用户重新登录；
6. 此后可以使用“忘记密码”。

不要再次提交注册表单。重复注册会返回“账号已经存在”，并且不会覆盖首次设置的密码。

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
