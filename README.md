# tg-signer

这是一个精简后的 Telegram 自动签到仓库。

当前稳定方案：

```text
Cloudflare Cron 每天北京时间 00:05 触发一次签到
Cloudflare Cron 每天北京时间 00:20 再触发一次备用签到
```

Cloudflare Worker 到点后会调用 GitHub API，触发 `Daily Telegram Checkin` 工作流。GitHub Actions 只负责执行签到，不再依赖 GitHub 自带 schedule。

---

## 当前流程

1. Cloudflare Cron 按北京时间 00:05 / 00:20 触发 Worker。
2. Worker 调用 GitHub API，触发 `Daily Telegram Checkin`。
3. workflow 读取仓库 Secrets。
4. 使用 `tg-signer` 登录你的 Telegram 用户号。
5. 向目标机器人发送固定签到文本。

---

## 定时时间

Cloudflare Cron 使用 UTC 时间，所以北京时间 00:05 和 00:20 对应：

```toml
crons = ["5 16 * * *", "20 16 * * *"]
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

## 必须配置的 Cloudflare Worker 密钥

Worker 里需要有：

| Secret / Variable | 用途 |
|---|---|
| `GITHUB_TOKEN` | 让 Worker 触发 GitHub Actions |
| `TRIGGER_KEY` | 手动访问 `/run` 时使用 |
| `GITHUB_OWNER` | 仓库所有者，当前是 `GrandpaNiuu` |
| `GITHUB_REPO` | 仓库名，当前是 `tg-signer-shadowrocket` |
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
