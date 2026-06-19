# tg-signer

这是一个精简后的 Telegram 自动签到仓库。

当前稳定方案：

```text
Cloudflare Cron 每天北京时间 00:00 触发一次签到
```

Cloudflare Worker 到点后会调用 GitHub API，触发 `Daily Telegram Checkin` 工作流。

简单理解：

```text
每天 00:00 → Cloudflare 叫醒 GitHub Actions → GitHub Actions 给机器人发签到消息
```

如果配置了第二个账号，两个账号会在同一次工作流里依次签到。

---

## 当前流程

1. Cloudflare Cron 每天北京时间 00:00 触发 Worker。
2. Worker 调用 GitHub API，触发 `Daily Telegram Checkin`。
3. workflow 读取仓库 Secrets。
4. 使用 `tg-signer` 登录第一个 Telegram 用户号并发送签到文本。
5. 如果配置了 `TG_SESSION_STRING_2`，再登录第二个 Telegram 用户号并发送同样的签到文本。

---

## 定时时间

Cloudflare Cron 使用 UTC 时间。北京时间比 UTC 快 8 小时，所以：

```text
北京时间 00:00 = UTC 16:00
```

仓库里实际配置的是：

```toml
crons = ["0 16 * * *"]
```

文件位置：

```text
worker/wrangler.toml
```

GitHub 工作流位置：

```text
.github/workflows/daily-checkin.yml
```

---

## 必须配置的 GitHub Secrets

进入：

```text
Settings → Secrets and variables → Actions
```

需要有这三个：

| Secret | 用途 |
|---|---|
| `TG_SESSION_STRING` | Telegram 用户号 session string |
| `TG_TARGET_CHAT` | 目标签到机器人，例如 `@xxx_bot` 或 chat id |
| `TG_CHECKIN_TEXT` | 要发送的签到文本 |

`TG_SESSION_STRING` 不要写进仓库，不要截图发给别人。

---

## 可选第二账号

如果要让另一个 Telegram 用户号也自动签到，额外添加：

| Secret | 用途 |
|---|---|
| `TG_SESSION_STRING_2` | 第二个 Telegram 用户号 session string |

默认情况下，第二个账号会复用第一个账号的 `TG_TARGET_CHAT` 和 `TG_CHECKIN_TEXT`。

如果第二个账号要发给不同机器人、群组或使用不同签到文本，可以继续添加：

| Secret | 用途 |
|---|---|
| `TG_TARGET_CHAT_2` | 第二个账号的目标签到机器人或 chat id |
| `TG_CHECKIN_TEXT_2` | 第二个账号的签到文本 |

高级配置也支持第二账号专用后缀：

```text
TG_MESSAGE_THREAD_ID_2
TG_SIGNER_TASK_NAME_2
TG_SIGNER_IMPORT_BASE64_2
TG_ACCOUNT_2
TG_PROXY_2
CHECKIN_DELETE_AFTER_2
```

没有配置 `TG_SESSION_STRING_2` 时，第二账号步骤会自动跳过，不影响第一个账号签到。

---

## 必须配置的 Cloudflare Worker 密钥

Worker 里需要有：

| Secret / Variable | 用途 |
|---|---|
| `GITHUB_TOKEN` | 让 Worker 触发 GitHub Actions |
| `TRIGGER_KEY` | 手动访问 `/run` 时使用 |
| `GITHUB_OWNER` | 仓库所有者，当前是 `GrandpaNiuu` |
| `GITHUB_REPO` | 仓库名，当前是 `Telegramautomaticcheck-in` |
| `GITHUB_WORKFLOW_FILE` | 当前是 `daily-checkin.yml` |
| `GITHUB_REF` | 当前是 `main` |

---

## 手动测试

进入：

```text
Actions → Daily Telegram Checkin → Run workflow
```

手动测试时，不需要填写任何输入框，直接运行。

---

## 保留文件说明

| 文件 | 作用 |
|---|---|
| `worker/cloudflare-worker.js` | Cloudflare Worker 触发器 |
| `worker/wrangler.toml` | Cloudflare Cron 定时配置 |
| `.github/workflows/deploy-worker.yml` | 部署 Worker |
| `.github/workflows/daily-checkin.yml` | 执行签到 |
| `scripts/run_checkin.sh` | 签到逻辑 |
| `scripts/notify.py` | 可选 Telegram 通知逻辑 |
| `.gitignore` | 防止 session、日志、环境文件被提交 |
| `.env.example` | Secrets 示例 |

---

## 安全注意

不要公开以下内容：

```text
TG_SESSION_STRING
Telegram 验证码
Telegram 二步验证密码
.session 文件
GitHub token
Cloudflare token
```

如果 `TG_SESSION_STRING` 泄露，应该重新生成并更新 GitHub Secret。
