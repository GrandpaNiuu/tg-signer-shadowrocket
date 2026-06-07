# tg-signer-shadowrocket

基于 [`amchii/tg-signer`](https://github.com/amchii/tg-signer) 的 Telegram 用户号签到方案：

- GitHub Actions 负责每天自动运行。
- Cloudflare Worker 负责接收 Shadowrocket 的触发请求。
- Shadowrocket 模块负责手机端手动触发或辅助定时触发。
- Telegram session、机器人 Token、触发密钥等敏感信息只放到 Secrets / Worker Variables，不写进仓库。

> 注意：这个项目不是让 Shadowrocket 直接登录 Telegram。Shadowrocket 只负责触发云端任务。真正控制 Telegram 用户号的是 GitHub Actions 里的 `tg-signer`。

---

## 1. 功能

第一版支持两种模式：

| 模式 | 用途 |
|---|---|
| `send-text` | 给指定机器人/聊天发送固定签到文本，例如 `/checkin`、`签到` |
| `task` | 运行已经配置好的 `tg-signer` 任务，适合点击按钮、动作流等复杂签到 |

建议先用 `send-text` 跑通，再处理复杂任务。

---

## 2. GitHub Secrets 配置

打开仓库：

```text
Settings → Secrets and variables → Actions → New repository secret
```

至少添加：

| Secret 名称 | 说明 | 示例 |
|---|---|---|
| `TG_SESSION_STRING` | Telegram 用户号 session string | 不要公开 |
| `TG_TARGET_CHAT` | 目标机器人 username 或 chat_id | `@example_bot` |
| `TG_CHECKIN_TEXT` | 要发送的签到文本 | `/checkin` |

可选：

| Secret 名称 | 说明 |
|---|---|
| `TG_MESSAGE_THREAD_ID` | 群组话题 ID，可不填 |
| `TG_PROXY` | tg-signer 代理，例如 `socks5://host:port` |
| `CHECKIN_DELETE_AFTER` | 发送后多少秒删除签到消息 |
| `TELEGRAM_NOTIFY_BOT_TOKEN` | 通知用 Telegram Bot Token |
| `TELEGRAM_NOTIFY_CHAT_ID` | 通知接收 chat_id |
| `TG_SIGNER_TASK_NAME` | `task` 模式下的任务名 |
| `TG_SIGNER_IMPORT_BASE64` | `tg-signer` 导出配置的 base64 内容 |

仓库变量 Variables 可选：

| Variable 名称 | 说明 | 默认 |
|---|---|---|
| `CHECKIN_TZ` | 运行时区 | `Asia/Shanghai` |
| `SIGN_MODE` | 默认模式：`send-text` 或 `task` | `send-text` |

---

## 3. GitHub Actions 自动签到

默认 workflow 文件：

```text
.github/workflows/daily-checkin.yml
```

默认时间：

```yaml
- cron: "0 0 * * *"
```

GitHub Actions 的 cron 使用 UTC。`0 0 * * *` 等于北京时间每天 08:00。

手动运行：

```text
Actions → Daily Telegram Checkin → Run workflow
```

---

## 4. Cloudflare Worker 触发 GitHub Actions

把 `worker/cloudflare-worker.js` 部署到 Cloudflare Worker。

Worker 需要配置这些变量：

| 变量名 | 说明 | 示例 |
|---|---|---|
| `TRIGGER_KEY` | Shadowrocket 触发密钥，自己设置一个长随机字符串 | `change-this-key` |
| `GITHUB_TOKEN` | GitHub fine-grained token，需要 Actions write 权限 | 不要公开 |
| `GITHUB_OWNER` | 仓库 owner | `GrandpaNiuu` |
| `GITHUB_REPO` | 仓库名 | `tg-signer-shadowrocket` |
| `GITHUB_WORKFLOW_FILE` | workflow 文件名 | `daily-checkin.yml` |
| `GITHUB_REF` | 分支 | `main` |

Worker 触发地址格式：

```text
https://你的worker域名.workers.dev/run?key=你的TRIGGER_KEY
```

可附加参数：

```text
mode=send-text
target_chat=@example_bot
checkin_text=/checkin
task_name=my_sign
```

---

## 5. Shadowrocket 模块

模块文件：

```text
shadowrocket/tg-signer.sgmodule
```

导入后配置参数：

| 参数 | 说明 |
|---|---|
| 云端接口 | Cloudflare Worker 的 `/run` 地址 |
| 触发密钥 | Worker 里的 `TRIGGER_KEY` |
| 模式 | `send-text` 或 `task` |
| 目标聊天 | `send-text` 模式使用，例如 `@example_bot` |
| 签到文本 | `send-text` 模式使用，例如 `/checkin` |
| 任务名 | `task` 模式使用 |
| 启用定时触发 | 可开可不开，建议只作为辅助 |
| 定时表达式 | 例如 `0 8 * * *` |

手机手动触发：

```text
http://tg-signer.local/run
```

可以用 iOS 快捷指令创建一个“打开 URL”的桌面按钮。

---

## 6. 推荐使用方式

稳定方案：

```text
GitHub Actions 每天自动签到
Shadowrocket 手动补签
Telegram Bot 通知结果
```

不建议只依赖 Shadowrocket 定时，因为 iOS 后台运行不保证长期稳定。

---

## 7. 风险边界

只建议用于：

- 你自己的 Telegram 用户号。
- 单个或少量正常签到机器人。
- 低频签到。
- 不绕验证码、不刷积分、不群发、不骚扰。

不要用于多账号批量、绕风控、群发私信或其他滥用行为。
