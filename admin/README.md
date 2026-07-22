# Telegram 自动消息后台

这是部署在 Cloudflare Pages 上的网页管理端。它本身不直接连接 Telegram，而是通过 Pages Function 的 `CONTROL_PLANE` Service Binding 访问 Cloudflare Worker；真正的 Telegram 登录和任务执行由 GitHub Actions Runner 完成。

> 页面能打开，不代表全部功能已经配置完成。Worker、D1、Service Binding、GitHub OAuth、Actions 或 Telegram 应用凭据缺失时，页面可能仍能加载，但对应操作会失败。

## 登录方式

- GitHub OAuth：配置正确时，首次登录可以创建独立工作区。
- 邮箱登录：代码支持邮箱验证、Turnstile、找回密码和会话撤销。
- 邮箱新注册是否开放，以生产 `/api/auth/config` 为准，不能仅根据仓库中存在相关代码判断。
- 邮件服务或 Turnstile 未配置完整时，已有邮箱用户可能仍可登录，但邮箱新注册和找回密码会关闭。

## 页面功能

- **概览**：今日执行、成功、失败、进行中、最近运行和脱敏日志。
- **Telegram 账号**：网页只提供手机号登录；依次完成验证码和可选二步验证。Session 导入与代理配置不再作为普通用户入口。
- **自动消息任务**：账号、Skill、目标、消息或命令、Cron、Retry、Timeout、Thread、Delete After、启停、复制和手动执行。“定时发送任意内容”可直接选择并预览图片、视频、语音、音频或文件，也兼容 Telegram 消息链接。
- **Skills**：只读展示 Worker 中已经部署的代码白名单；网页不能上传任意 Python 或 Shell 代码。
- **执行记录**：查看手动与定时运行、状态、计划时间、调度偏差、耗时、重试和脱敏日志。
- **登录会话**：查看当前网页账号的会话并撤销其他会话。
- **用户管理**：仅管理员可查看用户资源数量、最近活动，并停用或恢复用户。
- **设置**：平台级 Telegram API_ID/API_HASH、默认时区和通知配置。

### 关于“秒级 Cron”

任务编辑器允许填写 6 段 Cron：`秒 分 时 日 月 星期`。这表示系统会记录目标秒并让 Runner 尝试等待到该时间，不表示 GitHub Actions 能保证严格准点。GitHub 排队晚于目标时间时，任务会延迟，后台会显示调度偏差。

### 关于 Telegram 应用凭据

普通用户新增账号时不填写 API_ID/API_HASH，但平台管理员必须先在设置中配置一组有效凭据。未配置时手机号登录不可用。这不是 Telegram 账号自己的验证码，也不能从手机号自动推导。

### 关于旧 Session 和代理

已迁入 D1 的旧账号、Session 和代理数据仍可供底层兼容使用，但网页不再显示 Session 导入和代理输入框。不要把“底层兼容”理解成面向新用户提供的功能。

## 自动刷新

- 首页会定期拉取新的定时运行。
- 执行记录页在有运行中任务时高频刷新，空闲时低频刷新。
- 浏览器切到后台时会停止无意义请求。
- 自动刷新只负责更新页面，不会触发任务本身；任务由 Worker Cron 调度。

## 本地检查

不需要安装前端构建依赖：

```sh
npm test --prefix admin
```

可以使用静态服务器预览页面，但没有 Pages Function、Service Binding 和有效认证时，只能验证静态界面，不能验证真实登录、D1 数据或 Telegram 执行链路。

## Cloudflare Pages 部署

本项目使用 Direct Upload，由 `.github/workflows/deploy-admin.yml` 发布。不要同时启用另一套会重复部署的 Pages Git integration。

关键配置：

- 上传目录：`admin/`
- Service Binding 名称：`CONTROL_PLANE`
- Service Binding 目标：实际部署的 Worker 服务
- `CANONICAL_HOST`：生产自定义域名
- GitHub OAuth callback：生产域名下的 `/api/auth/github/callback`

部署工作流会检查首页和认证配置接口，但自动检查通过仍不能替代一次真实浏览器验收。

## 邮箱注册配置

生产邮箱注册需要以下配置同时有效：

- `PASSWORD_PEPPER`
- `TURNSTILE_SITE_KEY`
- `TURNSTILE_SECRET_KEY`
- `RESEND_API_KEY`
- `AUTH_EMAIL_FROM`

`AUTH_EMAIL_FROM` 必须属于邮件服务已经验证的发件域名，Turnstile 也必须允许生产后台域名。配置不完整时，前端应显示邮箱注册关闭，而不是显示一个无法提交的表单。

## 安全约束

- API_ID、API_HASH、Session、验证码、二步验证密码和通知凭据不在页面中回显。
- 浏览器代码不使用 `localStorage`、`sessionStorage` 或 IndexedDB 保存秘密。
- API、页面和 Pages Function 使用 `no-store`。
- 写请求要求同源 `Origin` 和应用请求头。
- Pages Function 不信任浏览器伪造的管理员或 Access 身份头；Worker 独立验证 D1 会话。
- CSP 仅允许明确需要的资源，例如 Cloudflare Turnstile。
- 页面只显示 Worker 已脱敏的日志。

安全措施降低泄露风险，但不代表部署者可以公开截图、验证码、Session、API_HASH、Bot Token 或 Secret。

## API 契约

后台主要使用 `/api/v1`：

- `/dashboard`
- `/accounts`
- `/accounts/validate-all`
- `/login-flows`
- `/tasks` 与 `/tasks/{id}/runs`
- `/media-uploads`（最多 20 MB 的加密短期中转，完成 Telegram 暂存后自动清理文件分块）
- `/skills`
- `/task-runs`
- `/admin/users`
- `/settings`

成功响应为 `{ "data": ... }`；失败响应为 `{ "error": { "code", "message", "request_id"? } }`。敏感字段不得出现在响应或错误信息中。
