# Telegram 自动消息平台

这是一个基于 Cloudflare 和 GitHub Actions 的多用户 Telegram 自动化平台。用户通过网页管理 Telegram 账号、定时任务、机器人命令、执行记录和通知；Cloudflare Worker 负责权限、调度、加密与数据存储，短生命周期 GitHub Actions Runner 负责实际连接 Telegram。

项目最初用于 Telegram 自动签到，现在也可以用于定时发送普通消息、向机器人发送命令，以及运行仓库中经过审核的 Telegram Skill。

> 本项目不是 Telegram 官方产品，也不是零配置的一键部署项目。部署者需要自行准备并配置 Cloudflare、GitHub OAuth、GitHub Actions、D1、Worker、Pages 和相关 Secret。

## 使用前先看

- **网页新增 Telegram 账号只提供手机号登录。
- **6 段 Cron 支持填写秒，但不代表严格准点。** Cloudflare Cron 和 GitHub Actions 排队都可能造成延迟，后台会显示调度偏差。
- **邮箱功能写进代码，不等于生产环境已经开启。** Turnstile、发件服务和相关 Secret 未配置完整时，邮箱新注册与找回密码会安全关闭。
- **通知属于尽力发送，不保证必达。** 通知失败不会把已成功的 Telegram 任务改成失败。
- **仓库没有写死账号或任务数量上限，不代表无限使用。** 实际容量受 Cloudflare、GitHub Actions 和 Telegram 限制。
- **自动化可能触发 Telegram 的风控或账号限制。** 使用者需要控制频率，并自行遵守 Telegram 和目标机器人的规则。

## 当前能力

### 用户与登录

- GitHub OAuth 登录；首次登录可以创建独立工作区。
- 安全邮箱体系包含邮箱验证、Turnstile、找回密码和会话撤销。
- 邮箱注册只有在生产安全配置完整后才开放；关闭时不是数据库故障。
- 每位用户只能访问自己的 Telegram 账号、任务、执行记录和登录会话。
- 管理员可以查看用户资源数量，并停用或恢复用户访问。

### 自动消息与签到

- 支持普通消息、机器人命令和代码白名单中的 Skill。
- 支持每日、每周、每小时、分钟间隔和高级 Cron。
- 支持 Retry、Timeout、Thread ID、Delete After、启停、复制与手动执行。
- 同一 Telegram 账号的任务串行执行；不同账号可以并行。
- 任务是否成功取决于 Telegram、目标账号、机器人状态和外部网络，平台不能保证每次都成功。

### 执行记录

- 手动执行和定时执行统一写入 D1 的 `task_runs`。
- 显示任务、账号、触发方式、计划时间、实际开始、调度偏差、耗时、重试和结果。
- 首页和执行记录页会自动发现新的定时运行，不需要依靠手动执行刷新。
- 结果无法确认时记录为 `ambiguous`，不会盲目重试造成重复签到或重复发送。

## 运行架构

```text
Cloudflare Pages
  网页后台与登录入口
          │
          ▼
Cloudflare Worker
  API、权限、加密、D1 调度、GitHub OIDC 校验
          │
          ├── Cloudflare D1
          │     用户、账号、任务、运行记录、脱敏日志
          │
          └── workflow_dispatch
                只传 run_id / flow_id
                        │
                        ▼
                 GitHub Actions
                        │
                        ▼
                  Python Runner
                        │
                        ▼
                    Telegram
```

D1 是配置、调度和运行记录的唯一数据源。Cloudflare Cron 创建运行记录并派发 GitHub Actions。Runner 领取任务、连接 Telegram、执行操作，然后通过 Worker 回写状态和脱敏结果。

GitHub Actions 不是硬实时调度器。即使 Cron 中填写了秒，Runner 也只能在 GitHub 已经分配运行环境后尝试等待到目标秒；排队晚于目标时间时，任务会延迟执行。

## 安全边界

- D1 敏感值使用 AES-256-GCM 应用层加密。
- `SECRET_ROOT_KEY` 只存在于 Cloudflare Worker Secret。
- GitHub workflow input 只传不敏感的 `run_id` 或 `flow_id`。
- Runner 使用 GitHub OIDC 短期身份领取任务和回写结果。
- Session 不出现在命令行参数；敏感临时文件使用严格权限并在退出时清理。
- 用户作用域缺失时 API 直接拒绝请求，不回退到全局数据访问。
- 邮箱密码使用 PBKDF2-HMAC-SHA256、随机盐和部署级 pepper。
- 注册、登录、找回密码和重置密码使用不同的 Turnstile action，并校验生产域名。
- 找回密码对存在和不存在的邮箱返回一致结果，避免账户枚举。
- 日志在保存和通知前都会脱敏，但部署者仍不应把 Secret、Session、验证码或密码发到 Issue、聊天或截图中。

## 仓库结构

| 路径 | 用途 |
|---|---|
| `admin/` | Cloudflare Pages 网页后台和同源 API 代理 |
| `worker/` | Worker、D1 migrations、认证、调度、管理 API、Runner API 和加密模块 |
| `runner/` | Telegram Runner、登录 Runner、TaskSpec、Skill Registry 和测试 |
| `.github/workflows/task-runner.yml` | Telegram 任务执行工作流，只接收 `run_id` |
| `.github/workflows/telegram-login.yml` | 手机号登录与账号验证工作流 |
| `.github/workflows/quality.yml` | Worker、Admin、Runner 和部署安全测试 |
| `.github/workflows/live-auth-audit.yml` | 生产站点与认证状态审计 |

## 部署前提

这不是只 Fork 仓库就能使用的项目。完整部署至少需要：

1. Cloudflare D1 数据库；
2. Cloudflare Worker；
3. Cloudflare Pages Direct Upload 项目；
4. Pages 到 Worker 的 `CONTROL_PLANE` Service Binding；
5. GitHub OAuth App；
6. 能派发 Actions 的 GitHub Token；
7. `SECRET_ROOT_KEY`、OAuth Secret 等 Worker Secrets；
8. 管理员配置的 Telegram API_ID/API_HASH；
9. 若开放邮箱注册，还需要 Turnstile、已验证发件域名和邮件服务 API Key。

缺少某一项时，页面可能仍能打开，但相应功能会不可用。例如：

- Pages 正常但 Worker 不可用：网页能加载，数据和操作会失败；
- Worker 正常但 Actions 被禁用：可以查看数据，登录 Telegram 和执行任务会失败；
- Telegram 应用凭据未配置：新增账号的手机号登录不可用；
- 邮件或 Turnstile 未配置：GitHub 登录仍可用，但邮箱新注册和找回密码关闭。

详细部署参数见 `worker/README.md`、`admin/README.md` 和 `docs/registration.md`。

## 网页 Telegram 登录流程

```text
输入手机号
  → GitHub 登录 Runner 请求 Telegram 验证码
  → 用户在网页输入验证码
  → 如账号启用了二步验证，再输入密码
  → Runner 调用 get_me 校验身份
  → Runner 导出 Session
  → Worker 加密写入 D1
  → 账号状态变为 connected
```

“普通用户无需填写 API_ID/API_HASH”只表示它们不会在新增账号表单中重复出现，并不表示平台不需要这些凭据。平台管理员必须先在设置中完成配置。

## 测试

```bash
python -m unittest discover -s runner/tests -p 'test_*.py' -v
npm test --prefix worker
npm test --prefix admin
node --test tools/*.test.mjs
```

CI 会在 `Quality Checks` workflow 中运行对应测试。测试通过只证明仓库内契约没有回归，不等同于 Cloudflare、GitHub、Telegram 和邮件服务的生产配置一定正确；生产环境还需要执行 smoke check 和线上审计。

## 兼容范围

- 已迁入 D1 的旧账号、Session、任务和历史运行继续可用。
- 旧 5 段 Cron 按第 0 秒解释；新任务可以使用 6 段 Cron。
- `send-text`、`task` 等旧名称继续映射到当前 Skill。
- 旧代理和导入字段可能仍存在于底层数据结构，用于兼容已迁移数据，但网页不再提供普通用户配置入口。
- 日常账号与任务管理请使用网页后台；D1 id、OAuth 凭据、Worker Secret 和部署 Token 属于基础设施配置。