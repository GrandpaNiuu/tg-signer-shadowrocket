# 24 小时 Telegram Listener

这个目录提供独立的常驻 Telegram 执行器。它用于：

- 用户端“自动识别机器人操作”；
- 管理员账号连接检测；
- 管理员 24 小时关键词自动回复；
- 管理员全天候群消息监听；
- 把网页直接选择的图片、视频、语音、音频和文件暂存到所选账号的 Telegram“收藏夹”；
- 执行启用了实时规则的管理员账号自身的定时消息、签到和审核通过的 Skill。

GitHub Actions 继续负责普通账号短任务、Telegram 手机号登录和部署；Listener 需要在一台长期在线的 VPS 上运行。实时账号的任务不会再派发给 GitHub Actions，从而避免两个执行器同时使用同一 Telegram Session。

## 执行模型

```text
Cloudflare Cron 创建 task_run
        │
        ├── 普通账号 → GitHub Actions Runner
        │
        └── 启用实时规则的管理员账号 → VPS Listener
                                        │
                                        ├── 暂停该账号实时连接
                                        ├── 执行定时任务并回写结果
                                        └── 恢复关键词回复和群监听
```

同一个实时账号的 Telegram 操作保持串行。执行短任务期间，该账号会有短暂的实时监听空窗；任务完成后自动恢复。不同账号仍可以由各自的客户端并行保持连接。

## 安全边界

- 用户只能识别自己工作区中已连接账号的机器人回复和按钮。
- 用户识别只发送指定命令并读取结果，不会自动点击按钮。
- 关键词回复、群监听、实时账号定时执行和 Listener 状态只对平台管理员开放。
- 实时规则只能使用管理员工作区内的账号。
- Worker 不会把实时账号的任务派发给 GitHub Actions Runner。
- 机器人识别与已领取或运行中的任务不能同时使用同一账号。
- Worker 只向通过 `LISTENER_API_TOKEN` 验证的 Listener 返回解密后的短期运行数据。
- Listener 使用内存 Session，容器文件系统只读，不持久化 Telegram Session。
- 多个 Listener 同时在线时，Worker 只向一个主实例返回账号、规则和任务；其他实例保持待命，主实例失联后自动接管。

## 1. 生成共享 Token

在本地或 VPS 执行：

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
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

## 2. 准备 VPS

要求：

- Debian 12、Ubuntu 22.04/24.04 或其他可运行 Docker 的现代 Linux；
- Docker Engine 与 Docker Compose 插件；
- VPS 能访问 Telegram、Cloudflare Worker、PyPI 和 GitHub；
- 部署用户可以直接执行 `docker`，不依赖交互式 `sudo`；
- 建议至少 1 核 CPU、1 GB 内存；账号或任务较多时需要增加资源。

手工部署：

```bash
git clone https://github.com/GrandpaNiuu/Telegramautomaticcheck-in.git
cd Telegramautomaticcheck-in/listener
cp .env.example .env
```

编辑 `.env`：

```text
WORKER_URL=https://你的-worker-域名
LISTENER_API_TOKEN=与Worker Secret完全相同的随机值
LISTENER_INSTANCE_ID=listener-vps-1
LISTENER_LABEL=主监听服务器
LISTENER_SYNC_SECONDS=30
LISTENER_HEARTBEAT_SECONDS=60
LISTENER_INSPECTION_SECONDS=4
LISTENER_TASK_SECONDS=2
LISTENER_MEDIA_UPLOAD_SECONDS=2
```

每个同时在线的 Listener 必须使用不同且稳定的 `LISTENER_INSTANCE_ID`。不要在容器重启时随机生成实例编号。

启动：

```bash
docker compose up -d --build
```

查看状态：

```bash
docker compose ps
docker compose logs --tail=100 -f telegram-listener
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

## 3. 使用 GitHub Actions 一键部署

仓库中的 `.github/workflows/deploy-listener.yml` 会先运行 Listener 测试，再通过 SSH 上传不可变发布目录并执行 Docker Compose。GitHub Actions 只负责部署，Telegram 长连接与实时账号任务仍由 VPS 容器维持。

在仓库 Settings → Secrets and variables → Actions 中配置：

### Secrets

```text
LISTENER_API_TOKEN
LISTENER_VPS_HOST
LISTENER_VPS_USER
LISTENER_VPS_SSH_KEY_B64
LISTENER_VPS_KNOWN_HOSTS
```

其中：

- `LISTENER_VPS_SSH_KEY_B64` 是部署私钥文件的单行 Base64。对应公钥必须加入 VPS 用户的 `~/.ssh/authorized_keys`。
- 工作流仍兼容旧的多行 `LISTENER_VPS_SSH_KEY`，但推荐使用 Base64 版本，避免网页复制破坏换行。
- `LISTENER_VPS_KNOWN_HOSTS` 必须是经过核对的 VPS 主机公钥记录；工作流不会关闭主机密钥检查。
- `LISTENER_API_TOKEN` 必须与 Cloudflare Worker 中的同名 Secret 完全一致。

生成部署私钥 Base64：

```bash
base64 -w 0 /root/listener_actions_key
echo
```

从可信终端生成 known_hosts 内容：

```bash
ssh-keyscan -H 你的VPS地址
```

首次使用前应通过 VPS 服务商控制台或其他可信渠道核对主机指纹，不能只依赖同一网络中的 `ssh-keyscan` 结果。

### Variables

```text
WORKER_URL=https://你的-worker-域名
LISTENER_VPS_PORT=22
```

`LISTENER_VPS_PORT` 可不填，默认使用 `22`。

配置完成后打开 Actions → `Deploy Telegram Listener` → `Run workflow`。工作流会部署到 VPS 用户目录：

```text
~/telegramautomaticcheckin/releases/<commit-sha>
```

当前版本软链接：

```text
~/telegramautomaticcheckin/current
```

工作流保留最近五个发布目录。部署失败时会输出容器的最后 150 行日志，但不会输出 `.env`、Session 或 Token。

## 4. 后台使用

管理员登录后打开“设置”，查看“24 小时实时服务”。

Listener 心跳正常时会显示“在线”。创建实时规则前，账号需要满足：

1. 已经通过手机号登录并显示“已连接”；
2. 账号处于启用状态；
3. 账号属于管理员工作区。

现在可以对同一个管理员账号同时：

- 创建关键词自动回复或群消息监听规则；
- 创建并启用普通定时消息、签到或 Skill 任务。

只要该账号存在至少一条启用中的实时规则，Worker 就会把它的排队任务交给 Listener。停用该账号的全部实时规则后，后续普通任务会重新走 GitHub Actions Runner。

普通用户创建“机器人按钮签到”时，可以点击“自动识别机器人操作”。Listener 会发送任务表单中的命令，读取机器人回复和按钮，用户选择按钮后再保存任务。

## 运维说明

- Listener 心跳超过约 150 秒未更新时，后台显示离线。
- 主实例失联约两分钟后，健康的待命实例会获得账号、规则和任务并接管处理。
- 配置默认每 30 秒同步一次；待命实例不会建立 Telegram 实时账号连接，也不会领取识别任务或定时任务。
- 识别任务默认每 4 秒轮询一次。
- 实时账号排队任务默认每 2 秒检查一次，但只会领取接近计划时间的运行。
- 网页文件暂存默认每 2 秒检查一次；Listener 成功存入 Telegram“收藏夹”后，Worker 会立即删除 D1 中的加密文件分块。
- 规则更新后通常在 30 秒内生效。
- 定时任务执行期间，该账号的实时连接会短暂停止，执行完成后自动恢复。
- Listener 重启期间不会处理新消息；恢复后不会补处理离线期间所有历史消息。未过期的排队任务仍可继续领取。
- 关键词回复是固定文本匹配，不执行任意代码、脚本或外部命令。
- 自动回复忽略自己发出的消息和机器人发送者，并有单会话冷却与每小时数量限制。
- 群消息预览会经过 Worker 截断和日志清理后写入 D1。
- `listener_events` 保留 30 天；已结束的机器人识别记录与长期离线实例保留 7 天，Worker 每小时自动清理一次。
