# 注册与登录状态

生产入口：`https://grandpaniu.ccwu.cc`

> 仓库中存在注册、验证和找回密码代码，不代表生产环境已经开放这些功能。生产状态由实际部署的 Worker 配置决定，应以 `/api/auth/config` 和 `Live Authentication Audit` 为准。

## 当前状态如何判断

仓库提供 `Live Authentication Audit` workflow。它会访问生产首页和 `/api/auth/config`，只记录以下非敏感状态：

- GitHub 登录与首次注册是否可用；
- 已有邮箱用户是否可以登录；
- 邮箱新注册是否开放；
- 邮箱验证、找回密码和 Turnstile 是否完整；
- 生产首页、关键前端资源和认证接口是否能正常访问。

该审计不会输出 OAuth Secret、密码 pepper、Turnstile Secret、邮件 API Key、邮箱地址或用户数据。默认每天运行，也可以手动运行。手动运行时将 `require_email_registration` 设为 `true`，可以把“邮箱注册仍关闭”视为失败。

页面显示“邮箱注册尚未开放”时，刷新网页、重新注册或重新启动浏览器都不会解决问题；管理员必须补齐生产配置并重新部署 Worker。

## 注册方式

### GitHub 注册

GitHub OAuth Client ID、Client Secret、回调地址和 Worker 配置全部正确时，首次使用 GitHub 登录会创建独立用户工作区。该方式不依赖邮件服务。

“仓库支持 GitHub 登录”不代表任意 Fork 都能直接使用；每个部署者都需要创建并配置自己的 OAuth App。

### 邮箱注册

生产环境只允许经过验证的邮箱注册。以下五项必须同时有效：

1. GitHub Secret：`PASSWORD_PEPPER`；
2. GitHub Variable：`TURNSTILE_SITE_KEY`；
3. GitHub Secret：`TURNSTILE_SECRET_KEY`；
4. GitHub Secret：`RESEND_API_KEY`；
5. GitHub Variable：`AUTH_EMAIL_FROM`。

Turnstile Widget 必须允许生产后台域名。`AUTH_EMAIL_FROM` 必须使用邮件服务已经验证的发件域名；随便填写邮箱地址不会让邮件正常发送。

不要把上述 Secret 发到聊天、Issue、截图或仓库文件中。

配置完成后运行 `Deploy Cloudflare Worker`，部署模式保持 `fresh_install`。部署 workflow 会检查：

- 邮箱安全配置不能只配置一部分；
- Worker `/health` 返回健康；
- Worker `/ready` 返回就绪；
- `/api/auth/config` 显示邮箱注册、邮箱验证、找回密码和 Turnstile全部启用。

最后手动运行 `Live Authentication Audit`，并将 `require_email_registration` 设为 `true`。审计通过后，再使用真实邮箱完成一次“注册 → 收信 → 点击验证 → 登录 → 找回密码”的人工验收。

自动测试和接口状态通过，不保证邮件一定进入收件箱；发件域名信誉、垃圾邮件过滤和邮件服务额度仍可能影响送达。

## 安全关闭状态

当 `PASSWORD_PEPPER` 已存在，但邮件服务或 Turnstile 未完整配置时：

- 已有邮箱用户仍可登录；
- 新邮箱注册关闭；
- 自助找回密码关闭；
- GitHub 登录与首次注册可以继续使用，但前提是 GitHub OAuth 自身配置正确。

这是预期的 fail-closed 状态，不是数据库故障。系统不会为了让注册按钮可用而退回到未验证邮箱直接注册。

## 常见误解

- **“代码已经合并，邮箱注册为什么还没有？”** 因为代码不能自动生成 Turnstile 和邮件服务凭据。
- **“页面能打开，为什么注册失败？”** Pages 能加载不代表 Worker、Service Binding、OAuth 或邮件服务均正常。
- **“配置了发件邮箱为什么收不到？”** 发件域名必须在邮件平台验证，邮件也可能被收件方过滤。
- **“GitHub 登录可用，说明邮箱也应该可用？”** 两种登录方式依赖不同的外部配置，状态可以不同。
- **“把 Secret 写进仓库更方便吗？”** 不可以。公开仓库中的 Secret 应视为已经泄露并立即轮换。