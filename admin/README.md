# Telegram 自动签到后台

Cloudflare Pages 上的轻量 Telegram 自动签到后台。它是一个无构建依赖的 HTML/CSS/ES modules 单页应用，通过 Pages Function 的 `CONTROL_PLANE` Service Binding 同源访问 Worker。

支持 GitHub 首次登录自动注册和邮箱验证注册。每个用户拥有独立的账号、任务和日志空间；配置中的不可变 GitHub user id 对应保留旧数据的管理员。这里没有支付、套餐、团队或商业后台。

## 页面

- 概览：今日执行、成功、失败、进行中、最近运行和脱敏日志。
- Telegram 账号：默认只输入手机号，再由短时 GitHub Login Runner 完成可重发/重试验证码和可选 2FA；旧 Session 导入保留为高级方式。支持编辑、删除、启停和随时检查连接状态。
- 签到任务：账号、Skill、Bot、Command、Cron、Retry、Timeout、Thread、Delete After 全字段 CRUD，支持手动执行和未来五次 Cron 预览。
- Skills：只读展示 Worker 中已部署的 `send_text`、`tg_signer` allowlist Registry。网页不能上传或执行任意代码。
- 执行记录：按任务和状态筛选，查看 attempts、结构化错误和脱敏日志。
- 登录会话：查看当前账号的设备会话并撤销其他会话。
- 设置：全局 Telegram API_ID/API_HASH（只配置一次或自动复用旧账号）、默认时区、`legacy`/`d1` 调度模式、通知开关。

## 本地检查

不需要 `npm install`：

```sh
npm test --prefix admin
```

纯静态页面可以用任意静态服务器预览，但在没有 Pages Function、Service Binding 和有效 GitHub 管理会话时，只会显示登录入口或服务未连接。

## Cloudflare Pages 部署

本项目统一使用 **Direct Upload**，不要同时启用 Pages Git integration。首次先在 Cloudflare 创建 `telegram-checkin-admin` Direct Upload 项目并上传一次，生产地址使用 **`https://grandpaniu.ccwu.cc`**；后续只由 `.github/workflows/deploy-admin.yml` 发布：

- Framework preset：None
- Build command：留空
- Production branch：`main`
- 上传目录：`admin/`
- Service Binding：变量名 `CONTROL_PLANE`，服务 `tg-signer-shadowrocket`
- 环境变量：生产环境设置 `CANONICAL_HOST=grandpaniu.ccwu.cc`

`wrangler.toml` 已包含 Pages 输出目录和 Service Binding。部署 workflow 使用固定 Wrangler 版本执行 Direct Upload；生产绑定仍需核对目标 Worker 名称。

不需要开通 Cloudflare Zero Trust，也不需要银行卡或账单授权。在 GitHub 创建一个 OAuth App，把 Homepage URL 设为 `https://grandpaniu.ccwu.cc`，Authorization callback URL 设为 `https://grandpaniu.ccwu.cc/api/auth/github/callback`。Client ID 与 Client Secret 只保存为 Worker Secrets。所有 `pages.dev` 主机名由全局 Pages middleware 以 308 跳转到固定的生产自定义域名。

邮箱注册是可选提供方：创建一个只允许生产后台域名的 Cloudflare Turnstile widget，并配置 `TURNSTILE_SITE_KEY`/`TURNSTILE_SECRET_KEY`；在邮件服务验证发件域名后配置 `RESEND_API_KEY`、`AUTH_EMAIL_FROM` 和随机 `PASSWORD_PEPPER`。四项未完整配置时页面不会显示一个无法使用的邮箱入口。

## 安全约束

- API_ID、API_HASH、Session、代理密码、验证码和 2FA 只存在于当前表单和当次请求；提交后立即清空，已保存值永不回显。
- 浏览器代码不使用 `localStorage`、`sessionStorage` 或 IndexedDB。
- API 返回、页面、Pages Function 均使用 `no-store`。
- 写请求要求同源 `Origin` 和 `X-Requested-With: tg-checkin-admin`。
- Pages Function 会丢弃浏览器伪造的 Access 与管理员身份头，只转发同源 HttpOnly 会话 Cookie；Worker 独立查询 D1 验证会话。
- CSP 禁止内联脚本、内联样式和任意第三方连接，仅允许显式的 Cloudflare Turnstile 脚本、验证连接与 frame。
- 页面只显示 Worker 已脱敏的日志，不提供原始秘密日志入口。

OAuth state 只能使用一次且十分钟过期；浏览器会话 Token 为随机 256 位值，D1 只保存 SHA-256 摘要，退出时立即撤销。

## API 契约

后台使用 `/api/v1`：

- `/dashboard`
- `/accounts`
- `/login-flows`
- `/tasks` 与 `/tasks/{id}/runs`
- `/skills`
- `/task-runs`
- `/settings`

成功响应为 `{ "data": ... }`；失败响应为 `{ "error": { "code", "message", "request_id"? } }`。所有字段使用 `snake_case`。敏感字段永远不能出现在响应或错误中。
