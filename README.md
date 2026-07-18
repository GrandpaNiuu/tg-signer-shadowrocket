# Telegram Automatic Check-in

Telegram 自动签到管理平台。它是在原仓库上做的增量升级：保留 Cloudflare Worker/Cron、GitHub Actions、`tg-signer`、`send-text`、Session、代理、通知和旧 Secrets，同时把日常账号、机器人、命令、Cron 与日志管理收敛到网页后台。

平台以个人维护为主，也支持公开注册后的独立个人空间。它只增加必要的 GitHub/邮箱注册和数据隔离，不包含支付、套餐、团队、任务市场、商业后台、VPS 常驻服务、Docker、Redis、Celery 或 Kubernetes。

## 运行架构

```text
Cloudflare Pages（GitHub OAuth / 邮箱登录后台）
        │ 同源 Pages Function / Service Binding
        ▼
Cloudflare Worker（API、调度、加密、GitHub OIDC 校验）
        │
        ├── Cloudflare D1（账号、任务、运行、脱敏日志）
        │
        └── workflow_dispatch（只传不敏感的 run_id / flow_id）
                ▼
          GitHub Actions
                ▼
          统一 Python Runner
                ▼
       send_text / tg_signer / Telegram 登录
                │
                └── 结果经 Worker 回写 D1
```

旧链路继续可用：

```text
Cloudflare Cron → 原 /run → daily-checkin.yml → run_checkin.sh → Telegram
```

D1 的 `scheduler_mode` 初始值为 `legacy`。只有完成迁移并在后台明确切换为 `d1` 后，动态任务调度才会接管；切回 `legacy` 即可回滚。Cron 只有在成功读取到该显式模式后才会调度；D1 暂时不可用时会失败关闭，避免旧链路与恢复后的 D1 任务重复签到，原 `/run` 仍可作为人工兼容入口。

## 后台能力

- 概览：今日执行、成功、失败、进行中和最近脱敏日志。
- 用户登录：GitHub 首次登录自动注册；邮箱注册必须验证，支持找回密码和撤销其他登录会话。每位用户只能访问自己的账号、任务与运行记录。
- Telegram 账号：添加、编辑、删除、启停、状态；支持导入旧 Session，并由短时 Runner 调用 `get_me` 验证后才标记 connected。
- 网页登录：新增账号只输入手机号，再依次输入验证码和可选 2FA；API_ID/API_HASH 在设置中统一配置一次，也可自动复用完整的旧账号凭据对。成功后自动导出并加密保存 Session。
- 签到任务：账号、Skill、Bot、Command、Cron、Retry、Timeout、Thread、Delete After，全字段 CRUD、启停和手动执行。
- Skill Registry：代码 allowlist 中的 `send_text` 与 `tg_signer`；数据库不能指定任意 Python/Shell 代码。
- 执行记录：状态、时间、错误、耗时、重试、attempts 和脱敏日志。
- 设置：全局 Telegram 应用凭据、默认时区、通知开关以及 `legacy`/`d1` 调度切换。

账号和任务数量没有仓库内的固定上限，实际吞吐受 Cloudflare 与 GitHub Actions 的个人账户配额限制。同一账号的任务串行执行，不同账号可以并行，避免多个 Runner 同时使用同一 Telegram Session。

## 仓库结构

| 目录/文件 | 用途 |
|---|---|
| `admin/` | 无构建依赖的 Cloudflare Pages 后台与同源 API 代理 |
| `worker/` | Worker、D1 migrations、管理/Runner API、调度与安全模块 |
| `runner/` | 统一 TaskSpec、Runner、Skill Registry、登录 Runner 与测试 |
| `scripts/run_checkin.sh` | 保留并加固的旧签到适配器 |
| `scripts/notify.py` | 保留的 best-effort Telegram 通知，发送前统一脱敏 |
| `scripts/migrate_legacy.py` | GitHub Secrets → D1 的一次性无损迁移器 |
| `.github/workflows/daily-checkin.yml` | 原签到 workflow，继续作为兼容/回滚入口 |
| `.github/workflows/task-runner.yml` | D1 任务 Runner，只接收 `run_id` |
| `.github/workflows/telegram-login.yml` | 短生命周期 Telegram 网页登录 Runner |
| `.github/workflows/migrate-legacy.yml` | 旧配置 dry-run/正式导入 |

## 安全边界

- Session、API_HASH、代理凭据、tg_signer 配置、验证码、2FA 和通知 Token 不会写入明文日志。
- D1 敏感值使用 AES-256-GCM 应用层加密；随机 nonce，AAD 绑定 owner、purpose 与 key version。
- `SECRET_ROOT_KEY` 只存在于 Cloudflare Worker Secret，不进入 D1、Pages、workflow input 或仓库。
- GitHub workflow input 只含不敏感 ID；Runner 用 GitHub OIDC 短期身份领取任务和回写结果。
- 验证码和 2FA 是短时、一次性输入；Runner 使用后清空，浏览器不使用 localStorage/sessionStorage/IndexedDB。
- Session 不出现在命令行参数；敏感临时目录权限为 `0700`、文件为 `0600`，退出清理。
- Timeout 或发送结果无法确认时记录为 `ambiguous`，不会盲目重试造成重复签到。
- Retry 只用于明确未执行的失败（例如 Telegram FloodWait）；连接中断保持不确定状态。
- Pages 与 Worker 使用 GitHub OAuth + S256 PKCE 或已验证邮箱登录；随机会话只以 SHA-256 摘要保存到 D1。只有配置的不可变 GitHub user id 会取得管理员角色，登录名相同不能冒充管理员。
- 邮箱密码使用 PBKDF2-HMAC-SHA256、独立随机盐和 Worker Secret 中的 pepper；注册、登录和重置密码均要求服务端验证 Turnstile，验证/重置令牌只存摘要且只能使用一次。

## 首次部署

首次基础设施配置仍需执行一次；完成后新增账号、任务、机器人、命令和 Cron 都在网页后台操作，不再改 Python、Shell、YAML 或 GitHub Actions。

1. 在 Cloudflare 创建 D1 数据库 `telegram-checkin`，记录 database id。
2. 在 Cloudflare Pages 先创建 **Direct Upload** 项目 `telegram-checkin-admin` 并做一次初始上传。不要同时启用 Git integration。
3. 使用 Pages 项目的默认生产地址 **`https://telegram-checkin-admin.pages.dev`**；不要求绑定自定义域名。
4. 在 GitHub 创建一个 OAuth App，供登录与自动注册使用；无需 Cloudflare Zero Trust 或账单授权：
   - Homepage URL：`https://telegram-checkin-admin.pages.dev`
   - Authorization callback URL：`https://telegram-checkin-admin.pages.dev/api/auth/github/callback`
   - 记录 Client ID，并生成 Client Secret；两者只写入 Worker Secret。
5. 在 `worker/wrangler.toml` 填写：
   - D1 database id；
   - `RUNNER_OIDC_AUDIENCE`：生产 Worker URL 加 `/api/runner`；
   - `ADMIN_ORIGIN=https://telegram-checkin-admin.pages.dev`；
   - 唯一管理员的 `ADMIN_GITHUB_LOGIN` 与不可变 `ADMIN_GITHUB_USER_ID`。
6. 配置 Worker Secrets：
   - 保留原 `GITHUB_TOKEN`、`TRIGGER_KEY`；
   - 新增 `SECRET_ROOT_KEY`（恰好 32 个随机字节的 Base64）；
   - 新增 `GITHUB_OAUTH_CLIENT_ID` 与 `GITHUB_OAUTH_CLIENT_SECRET`。
   - 若启用邮箱注册，新增 `PASSWORD_PEPPER`、`TURNSTILE_SECRET_KEY` 与 `RESEND_API_KEY`。
7. 若启用邮箱注册，在 Worker Variables 配置 Turnstile 的 `TURNSTILE_SITE_KEY` 和已经过发件域名验证的 `AUTH_EMAIL_FROM`；`PASSWORD_HASH_ITERATIONS` 默认 600000。未完整配置时邮箱入口会安全地隐藏，GitHub 登录仍可用。
8. 在 GitHub Repository Secrets 保留 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID`。Token 至少需要目标账号的 Workers Scripts Edit、D1 Edit 与 Cloudflare Pages Edit。Worker 使用的 `GITHUB_TOKEN` 需对本仓库有 Actions: write 权限。
9. 在 GitHub Repository Variables 配置：
   - `WORKER_URL`；
   - `WORKER_OIDC_AUDIENCE`（必须与 Worker 的 `RUNNER_OIDC_AUDIENCE` 完全一致）。
10. 运行 `Deploy Cloudflare Worker`；workflow 会先应用远程 D1 migration，再部署 Worker。
11. 运行 `Deploy Cloudflare Pages Admin`；`CONTROL_PLANE` Service Binding 指向 `tg-signer-shadowrocket`，生产环境保持 `CANONICAL_HOST=telegram-checkin-admin.pages.dev`。不创建 Cloudflare Access Application。

本仓库沿用原 Worker 名称，通常可以直接保留已有 Worker Secrets。若确实是全新 Cloudflare 账号，先完成一次 Worker 部署以创建服务，再设置 Worker Secrets，并重新部署/验证；不要把真实 Secret 写入 TOML 或仓库。

具体 Worker 与 Pages 配置说明见 `worker/README.md` 和 `admin/README.md`。

## 旧配置无损迁移

不要提前删除或改写旧 Secrets。

1. 在 `main` 分支手动运行 `Migrate Legacy Telegram Configuration`，保持 `apply=false`。
   - dry-run 只发送“哪些旧配置存在”的布尔信息，不传 Session、代理或 Token。
2. 确认计划中的账号/任务数量后，再运行一次并设置 `apply=true`。
   - workflow 读取现有 GitHub Secrets，通过 OIDC 直接发送到 Worker；Worker 加密后幂等写入 D1。
   - 主账号映射为 `legacy-primary`，第二账号映射为 `legacy-secondary`；原 `_2` 回退规则会被物化。
3. 在后台核对账号、任务、时区，并逐个手动执行。
4. 确认日志和通知正常后，把 `scheduler_mode` 从 `legacy` 改为 `d1`。
5. 至少保留旧 Secrets 和 `daily-checkin.yml` 一个观察周期；需要回滚时把模式切回 `legacy`。

迁移不会要求旧账号重新登录，也不会注销现有 Telegram Session。

## 网页 Telegram 登录

后台新增账号时：

```text
手机号
  → GitHub 登录 Runner 发送验证码
  → 后台输入验证码（无效可重试，未收到可重新发送）
  → 如需要，再输入 2FA 密码
  → Runner 调用 get_me 验证账号
  → Runner 导出 Session
  → Worker AES-GCM 加密入 D1
  → 账号状态变为 connected
```

API_ID 与 API_HASH 不再按账号填写。它们在“设置 → Telegram 应用”中加密保存一次，所有新账号统一使用；如果旧迁移账号已有完整凭据对，后台会自动复用，因此升级后无需重新配置。旧 Session 导入保留在新增账号窗口的高级标签中。

Cloudflare Worker 无法保持 Telegram 长连接，因此登录由一个最长 20 分钟的短生命周期 GitHub Actions job 承担。验证码和 2FA 不进入 workflow inputs 或 Actions 日志。导入已有 Session 时复用同一短时 workflow，只执行 Session + `get_me` 验证；验证通过前账号保持 disconnected/login_pending。

## 本地测试

不需要安装前端或 Worker npm 依赖：

```bash
python -m unittest discover -s tests/legacy -p 'test_*.py' -v
bash tests/legacy/test_run_checkin.sh
python -m unittest discover -s runner/tests -p 'test_*.py' -v
npm test --prefix worker
npm test --prefix admin
```

CI 会在 `Quality Checks` workflow 中执行同一组测试。

## 旧行为兼容

- Worker 名 `tg-signer-shadowrocket`、`/run`、`x-trigger-key`、原 Cron 语义和 `daily-checkin.yml` 保留。
- 旧查询参数 `?key=` 仅为兼容保留；新调用必须使用 header，避免密钥进入 URL 日志。
- `send-text`、`task` 旧模式继续接受，并映射到 `send_text`、`tg_signer`。
- 主/第二账号、Thread、Delete After、代理、tg-signer Base64 导入、目标格式归一化和特定 Bot peer workaround 保留。
- 原通知仍是 best-effort：通知失败不改变签到结果，但日志会先脱敏。

日常配置请只使用后台。基础设施 Secret、D1 id、GitHub OAuth 凭据等部署级值不属于日常账号/任务配置，也不会暴露在网页中。
