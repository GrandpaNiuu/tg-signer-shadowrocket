# Telegram 自动签到后台

个人使用的 Cloudflare Pages 管理后台。它是一个无构建依赖的 HTML/CSS/ES modules 单页应用，通过 Pages Function 的 `CONTROL_PLANE` Service Binding 同源访问 Worker。

这里没有注册、支付、多租户或团队功能。管理员通过 GitHub OAuth 登录，Worker 只接受配置中的唯一 GitHub 登录名和不可变 user id。

## 页面

- 概览：今日执行、成功、失败、进行中、最近运行和脱敏日志。
- Telegram 账号：导入旧 Session 并验证，或通过短时 GitHub Login Runner 完成手机号、可重发/重试验证码、可选 2FA 登录；支持编辑、删除、启停和随时检查连接状态。
- 签到任务：账号、Skill、Bot、Command、Cron、Retry、Timeout、Thread、Delete After 全字段 CRUD，支持手动执行和未来五次 Cron 预览。
- Skills：只读展示 Worker 中已部署的 `send_text`、`tg_signer` allowlist Registry。网页不能上传或执行任意代码。
- 执行记录：按任务和状态筛选，查看 attempts、结构化错误和脱敏日志。
- 设置：默认时区、`legacy`/`d1` 调度模式、通知开关。

## 本地检查

不需要 `npm install`：

```sh
npm test --prefix admin
```

纯静态页面可以用任意静态服务器预览，但在没有 Pages Function、Service Binding 和有效 GitHub 管理会话时，只会显示登录入口或服务未连接。

## Cloudflare Pages 部署

本项目统一使用 **Direct Upload**，不要同时启用 Pages Git integration。首次先在 Cloudflare 创建 `telegram-checkin-admin` Direct Upload 项目并上传一次，再绑定生产域名 **`grandpaniu.ccwu.cc`**；后续只由 `.github/workflows/deploy-admin.yml` 发布：

- Framework preset：None
- Build command：留空
- Production branch：`main`
- 上传目录：`admin/`
- Service Binding：变量名 `CONTROL_PLANE`，服务 `tg-signer-shadowrocket`
- 环境变量：生产环境设置 `CANONICAL_HOST=grandpaniu.ccwu.cc`

`wrangler.toml` 已包含 Pages 输出目录和 Service Binding。部署 workflow 使用固定 Wrangler 版本执行 Direct Upload；生产绑定仍需核对目标 Worker 名称。

不需要开通 Cloudflare Zero Trust，也不需要银行卡或账单授权。在 GitHub 创建一个 OAuth App，把 Homepage URL 设为 `https://grandpaniu.ccwu.cc`，Authorization callback URL 设为 `https://grandpaniu.ccwu.cc/api/auth/github/callback`。Client ID 与 Client Secret 只保存为 Worker Secrets。项目的 `pages.dev` 地址由全局 Pages middleware 以 308 跳转到自定义域名。

## 安全约束

- API_HASH、Session、代理密码、验证码和 2FA 只存在于当前表单和当次请求；提交后立即清空。
- 浏览器代码不使用 `localStorage`、`sessionStorage` 或 IndexedDB。
- API 返回、页面、Pages Function 均使用 `no-store`。
- 写请求要求同源 `Origin` 和 `X-Requested-With: tg-checkin-admin`。
- Pages Function 会丢弃浏览器伪造的 Access 与管理员身份头，只转发同源 HttpOnly 会话 Cookie；Worker 独立查询 D1 验证会话。
- CSP 禁止内联脚本、内联样式、第三方连接和 framing。
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
