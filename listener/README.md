# 24 小时 Telegram Listener

这个目录提供独立的常驻 Telegram 执行器。它用于：

- 用户端“自动识别机器人操作”；
- 管理员账号连接检测；
- 管理员 24 小时关键词自动回复；
- 管理员全天候群消息监听。

它不是 GitHub Actions 工作流。GitHub Actions 继续负责定时短任务、Telegram 登录和部署；Listener 需要在一台长期在线的 VPS 上运行。

## 安全边界

- 用户只能识别自己工作区中已连接账号的机器人回复和按钮。
- 用户识别只发送指定命令并读取结果，不会自动点击按钮。
- 关键词回复、群监听和 Listener 状态只对平台管理员开放。
- 实时规则只能使用管理员工作区内的账号。
- 实时账号不能同时存在启用中的普通定时任务。
- Worker 只向通过 `LISTENER_API_TOKEN` 验证的 Listener 返回加密数据解密后的运行时凭据。
- Listener 使用内存 Session，容器文件系统只读，不持久化 Telegram Session。

## 1. 生成共享 Token

在本地或 VPS 执行：

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

不要把结果提交到仓库或发送到聊天。

在 GitHub 仓库中新增 Secret：

```text
LISTENER_API_TOKEN
```

然后重新运行 `Deploy Cloudflare Worker`。部署后的 `/ready` 会显示：

```json
{
  "checks": {
    "realtime_listener": "configured"
  }
}
```

## 2. 部署到 VPS

要求：

- Ubuntu 22.04/24.04 或其他可运行 Docker 的 Linux；
- Docker Engine 与 Docker Compose 插件；
- VPS 能访问 Telegram 和你的 Cloudflare Worker；
- 建议至少 1 核 CPU、1 GB 内存；账号较多时需要增加资源。

```bash
git clone https://github.com/GrandpaNiuu/Telegramautomaticcheck-in.git
cd Telegramautomaticcheck-in/listener
cp .env.example .env
```

编辑 `.env`：

```text
WORKER_URL=https://你的-worker-域名
LISTENER_API_TOKEN=与GitHub Secret完全相同的随机值
LISTENER_INSTANCE_ID=listener-vps-1
LISTENER_LABEL=主监听服务器
```

启动：

```bash
docker compose up -d --build
```

查看状态：

```bash
docker compose ps
docker compose logs --tail=100 -f
```

更新：

```bash
git pull
docker compose up -d --build
```

停止：

```bash
docker compose down
```

## 3. 后台使用

管理员登录后打开“设置”，查看“24 小时实时服务”。

Listener 心跳正常时会显示“在线”。创建实时规则前，需要准备一个专用 Telegram 账号：

1. 账号已经通过手机号登录并显示“已连接”；
2. 账号处于启用状态；
3. 这个账号没有任何启用中的普通定时任务。

普通用户创建“机器人按钮签到”时，可以点击“自动识别机器人操作”。Listener 会发送任务表单中的命令，读取机器人回复和按钮，用户选择按钮后再保存任务。

## 运维说明

- Listener 心跳超过 150 秒未更新时，后台显示离线。
- 配置默认每 30 秒同步一次。
- 识别任务默认每 4 秒轮询一次。
- 规则更新后通常在 30 秒内生效。
- Listener 重启期间不会处理新消息；恢复后不会补处理离线期间所有历史消息。
- 关键词回复是固定文本匹配，不执行任意代码、脚本或外部命令。
- 群消息预览会经过 Worker 截断和日志清理后写入 D1。
