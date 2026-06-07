# 手机端部署步骤

这个项目的目标是：

1. GitHub Actions 负责运行 `tg-signer`。
2. Cloudflare Worker 负责接收 Shadowrocket 请求并触发 GitHub Actions。
3. Shadowrocket 只负责手机端触发，不保存 Telegram 登录信息。

## 1. 必须先配置 GitHub Actions Secrets

打开仓库：

```text
Settings -> Secrets and variables -> Actions -> New repository secret
```

至少添加：

| 名称 | 用途 |
|---|---|
| `TG_SESSION_STRING` | Telegram 用户号 session string |
| `TG_TARGET_CHAT` | 目标签到机器人，例如 `@example_bot` |
| `TG_CHECKIN_TEXT` | 签到文本，例如 `/checkin` |

可选通知：

| 名称 | 用途 |
|---|---|
| `TELEGRAM_NOTIFY_BOT_TOKEN` | 你自己的通知机器人 token |
| `TELEGRAM_NOTIFY_CHAT_ID` | 接收通知的 chat_id |

## 2. 先手动测试 GitHub Actions

打开：

```text
Actions -> Daily Telegram Checkin -> Run workflow
```

先用默认 `send-text` 模式测试。成功后，目标机器人会收到你的签到文本。

## 3. 部署 Cloudflare Worker

手机上最简单的方式是用 Cloudflare 网页后台：

```text
Workers & Pages -> Create Worker -> Edit code
```

把仓库里的这个文件复制进去：

```text
worker/cloudflare-worker.js
```

然后在 Worker 的 Settings / Variables 里添加：

| 变量名 | 类型 | 说明 |
|---|---|---|
| `TRIGGER_KEY` | Secret | 你自己设置的一串触发密钥 |
| `GITHUB_TOKEN` | Secret | GitHub token，需要能触发 Actions |
| `GITHUB_OWNER` | Variable | `GrandpaNiuu` |
| `GITHUB_REPO` | Variable | `tg-signer-shadowrocket` |
| `GITHUB_WORKFLOW_FILE` | Variable | `daily-checkin.yml` |
| `GITHUB_REF` | Variable | `main` |

## 4. Shadowrocket 导入模块

模块地址：

```text
https://raw.githubusercontent.com/GrandpaNiuu/tg-signer-shadowrocket/main/shadowrocket/tg-signer.sgmodule
```

导入后填写：

| 参数 | 填什么 |
|---|---|
| 云端接口 | Cloudflare Worker 地址，末尾要是 `/run` |
| 触发密钥 | 和 Worker 的 `TRIGGER_KEY` 一样 |
| 模式 | `send-text` |
| 目标聊天 | 你的签到机器人，例如 `@example_bot` |
| 签到文本 | `/checkin` 或实际签到文字 |

## 5. 手机手动触发

Safari 打开：

```text
http://tg-signer.local/run
```

Shadowrocket 会拦截这个地址，然后触发 Worker。

## 6. 不要公开这些内容

不要把下面内容发到聊天、截图或写进仓库文件：

```text
TG_SESSION_STRING
Telegram 验证码
Telegram 二步验证密码
GITHUB_TOKEN
Cloudflare API Token
TRIGGER_KEY
```
