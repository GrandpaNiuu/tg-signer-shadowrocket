# tg-signer

这是一个精简后的 Telegram 自动签到仓库。

当前只保留一种稳定方案：

```text
GitHub Actions 每天北京时间 00:05 自动发送签到文本
```

不再依赖 Cloudflare Worker 触发。

---

## 当前流程

1. GitHub Actions 按定时任务运行。
2. workflow 读取仓库 Secrets。
3. 使用 `tg-signer` 登录你的 Telegram 用户号。
4. 向目标机器人发送固定签到文本。

---

## 定时时间

GitHub Actions 使用 UTC 时间，所以北京时间 00:05 对应：

```yaml
- cron: "5 16 * * *"
```

文件位置：

```text
.github/workflows/daily-checkin.yml
```

GitHub 定时任务可能会有几分钟延迟，这是平台调度正常现象。为了避开整点高峰，当前设置为 00:05。

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
| `.github/workflows/daily-checkin.yml` | 每日定时签到 workflow |
| `scripts/run_checkin.sh` | 执行签到逻辑 |
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
```

如果 `TG_SESSION_STRING` 泄露，应该重新生成并更新 GitHub Secret。
