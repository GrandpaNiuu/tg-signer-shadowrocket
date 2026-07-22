# Telegram 自动消息平台

这是一个基于 Cloudflare、GitHub Actions 和可选常驻 Listener 的多用户 Telegram 自动化平台。用户通过网页管理 Telegram 账号、定时任务、机器人命令、执行记录和通知；Cloudflare Worker 负责权限、调度、加密与数据存储，短生命周期 GitHub Actions Runner 负责普通账号的短任务，VPS Listener 负责需要长期在线的 Telegram 功能及实时账号自身的定时任务。

项目最初用于 Telegram 自动签到，现在也可以用于定时发送普通消息、向机器人发送命令、按钮签到、识别机器人操作，以及运行仓库中经过审核的 Telegram Skill。

> 本项目不是 Telegram 官方产品，也不是零配置的一键部署项目。部署者需要自行准备并配置 Cloudflare、GitHub OAuth、GitHub Actions、D1、Worker、Pages 和相关 Secret。24 小时功能还需要一台长期在线的 VPS。

## 使用前先看

- **网页新增 Telegram 账号只提供手机号登录。**
- **6 段 Cron 支持填写秒，但不代表严格准点。** Cloudflare Cron、GitHub Actions 排队和外部网络都可能造成延迟；实时账号由 Listener 领取任务，可避开 GitHub Runner 排队，但仍依赖 Worker 及时创建运行记录。
- **邮箱功能写进代码，不等于生产环境已经开启。** Turnstile、发件服务和相关 Secret 未配置完整时，邮箱新注册与找回密码会安全关闭。
- **实时功能写进代码，也不等于 Listener 已在线。** 未配置 `LISTENER_API_TOKEN` 或未部署 VPS Listener 时，机器人操作识别、关键词自动回复、群消息监听及实时账号的定时任务不会运行。
- **通知属于尽力发送，不保证必达。** 通知失败不会把已成功的 Telegram 任务改成失败。
- **仓库没有写死账号或任务数量上限，不代表无限使用。** 实际容量受 Cloudflare、GitHub Actions、VPS 资源和 Telegram 限制。
- **自动化可能触发 Telegram 的风控或账号限制。** 使用者需要控制频率，并自行遵守 Telegram 和目标机器人的规则。

## 当前能力

### 用户与登录

- GitHub OAuth 登录；首次登录可以创建独立工作区。
- 安全邮箱体系包含邮箱验证、Turnstile、找回密码和会话撤销。
- 邮箱注册只有在生产安全配置完整后才开放；关闭时不是数据库故障。
- 每位用户只能访问自己的 Telegram 账号、任务、执行记录、机器人识别记录和登录会话。

### 自动消息与签到

- 支持发送一次消息或命令。
- 支持在任务表单中直接选择并预览图片、视频、语音、音频或普通文件；也可以复制已有 Telegram 消息，从而保留投票、位置、联系人等原生内容。
- 支持机器人按钮签到：发送命令、等待回复、点击指定按钮并匹配成功关键词。
- 用户可以使用“自动识别机器人操作”读取机器人的回复和按钮，再选择按钮生成任务；识别过程不会自动点击按钮。
- 支持每日、每周、每小时、分钟间隔和高级 Cron。
- 支持 Retry、Timeout、Thread ID、Delete After、启停、复制与手动执行。
- 同一 Telegram 账号的任务串行执行；不同账号可以并行。
- 任务是否成功取决于 Telegram、目标账号、机器人状态和外部网络，平台不能保证每次都成功。

### 管理员实时服务

以下能力只在管理员工作区显示：

- Telegram 账号连接检测；
- 24 小时关键词自动回复；
- 全天候群消息监听；
- Listener 在线状态、心跳、规则和实时事件查看。

启用实时规则的管理员账号可以继续创建和启用普通定时任务。Worker 会把这类任务保留给 VPS Listener，不再派发到 GitHub Actions；执行任务前 Listener 会暂时断开该账号的实时连接，任务结束后立即恢复，从而确保同一 Session 不会被两个执行器同时占用。

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
  API、权限、加密、D1 调度、Listener 鉴权
          │
          ├── Cloudflare D1
          │     用户、账号、任务、运行记录、实时规则和脱敏事件
          │
          ├── workflow_dispatch
          │       普通账号短任务 / 手机号登录
          │              │
          │              ▼
          │       GitHub Actions Runner
          │
          └── HTTPS + LISTENER_API_TOKEN
                         │
                         ▼
                 VPS Telegram Listener
                 长期连接、机器人识别、关键词回复、群监听
                 以及实时账号的定时任务
                         │
                         ▼
                     Telegram
```

D1 是配置、调度和运行记录的唯一数据源。Cloudflare Cron 创建运行记录：普通账号的运行由 Worker 派发到 GitHub Actions；存在启用中实时规则的管理员账号，其运行保持排队并由 Listener 领取。两类执行器都通过 Worker 获取短期运行数据并回写状态、尝试记录、脱敏日志和结果。

网页直接选择文件时，Worker 只把最多 20 MB 的内容作为短期加密分块暂存在 D1；Listener 随即把内容保存到所选 Telegram 账号的“收藏夹”，然后删除全部分块。任务长期保存的只是 Telegram 消息编号，不会把文件长期放在 D1。超过 20 MB 或属于投票、位置、联系人等 Telegram 原生内容时，应使用已有 Telegram 消息链接。

GitHub Actions 不是硬实时调度器，也不适合作为真正的 24 小时 Telegram 连接。即使 Cron 中填写了秒，Runner 也只能在 GitHub 已经分配运行环境后尝试等待到目标秒；排队晚于目标时间时，任务会延迟执行。实时账号由 Listener 常驻领取任务，可减少这一层排队，但仍不承诺绝对准点。

## 安全边界

- D1 敏感值使用 AES-256-GCM 应用层加密。
- `SECRET_ROOT_KEY` 只存在于 Cloudflare Worker Secret。
- GitHub workflow input 只传不敏感的 `run_id` 或 `flow_id`。
- Runner 使用 GitHub OIDC 短期身份领取任务和回写结果。
- Listener 使用独立的高强度 `LISTENER_API_TOKEN` 与 Worker 通信。
- Listener 只领取管理员工作区中启用了实时规则的账号任务。
- Listener Session 只在内存中使用；默认 Docker 配置使用只读文件系统。
- Session 不出现在命令行参数；敏感临时文件使用严格权限并在退出时清理。
- 用户作用域缺失时 API 直接拒绝请求，不回退到全局数据访问。
- 关键词回复和群监听只接受结构化白名单规则，不执行任意 Python、Shell 或外部命令。
- 邮箱密码使用 PBKDF2-HMAC-SHA256、随机盐和部署级 pepper。
- 注册、登录、找回密码和重置密码使用不同的 Turnstile action，并校验生产域名。
- 找回密码对存在和不存在的邮箱返回一致结果，避免账户枚举。
- 日志在保存和通知前都会脱敏，但部署者仍不应把 Secret、Session、验证码或密码发到 Issue、聊天或截图中。

## 仓库结构

| 路径 | 用途 |
|---|---|
| `admin/` | Cloudflare Pages 网页后台和同源 API 代理 |
| `worker/` | Worker、D1 migrations、认证、调度、管理 API、Runner API、Listener API 和加密模块 |
| `runner/` | 统一短任务执行引擎、登录 Runner、TaskSpec、Skill Registry 和测试 |
| `listener/` | VPS 常驻 Telegram Listener、实时账号任务执行、Docker 部署文件和测试 |
| `.github/workflows/task-runner.yml` | 普通账号 Telegram 短任务工作流，只接收 `run_id` |
| `.github/workflows/telegram-login.yml` | 手机号登录与管理员账号验证工作流 |
| `.github/workflows/quality.yml` | Worker、Admin、Runner、Listener 和部署安全测试 |
| `.github/workflows/live-auth-audit.yml` | 生产站点、关键前端资源与认证状态审计 |

## 部署前提

这不是只 Fork 仓库就能使用的项目。普通定时任务的完整部署至少需要：

1. Cloudflare D1 数据库；
2. Cloudflare Worker；
3. Cloudflare Pages Direct Upload 项目；
4. Pages 到 Worker 的 `CONTROL_PLANE` Service Binding；
5. GitHub OAuth App；
6. 能派发 Actions 的 GitHub Token；
7. `SECRET_ROOT_KEY`、OAuth Secret 等 Worker Secrets；
8. 管理员配置的 Telegram API_ID/API_HASH；
9. 若开放邮箱注册，还需要 Turnstile、已验证发件域名和邮件服务 API Key。

要启用实时功能，还需要：

10. GitHub Secret `LISTENER_API_TOKEN`；
11. 一台长期在线且能访问 Telegram 的 VPS；
12. 在 VPS 上运行 `listener/docker-compose.yml`；
13. 一个或多个管理员工作区中已连接的 Telegram 账号，并为其创建至少一条启用中的实时规则。

缺少某一项时，页面可能仍能打开，但相应功能会不可用。例如：

- Pages 正常但 Worker 不可用：网页能加载，数据和操作会失败；
- Worker 正常但 Actions 被禁用：可以查看数据，手机号登录和普通账号任务会失败；
- Telegram 应用凭据未配置：新增账号的手机号登录不可用；
- 邮件或 Turnstile 未配置：GitHub 登录仍可用，但邮箱新注册和找回密码关闭；
- Listener Token 或 VPS 未配置：普通账号定时任务仍可用，但机器人识别、24 小时功能和实时账号定时任务关闭。

详细部署参数见 `worker/README.md`、`admin/README.md`、`listener/README.md` 和 `docs/registration.md`。

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
python -m unittest discover -s listener/tests -p 'test_*.py' -v
python -m compileall -q listener
npm test --prefix worker
npm test --prefix admin
node --test tools/*.test.mjs
```

CI 会在 `Quality Checks` workflow 中运行对应测试。测试通过只证明仓库内契约没有回归，不等同于 Cloudflare、GitHub、Telegram、VPS 和邮件服务的生产配置一定正确；生产环境还需要执行 smoke check 和线上审计。
