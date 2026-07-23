# Telegram 自动消息平台

一个可以通过网页管理 Telegram 账号和自动消息任务的开源项目。

你可以在网页中登录自己的 Telegram 账号，然后创建定时消息、发送命令、发送图片或视频、执行机器人按钮任务，并查看每次任务的执行结果。

完成基础部署后，部署所有者还可以选择增加一台长期在线的 VPS，启用管理员专属的 24 小时自动回复、消息监听、账号连接检测和实时任务功能。

本项目使用：

- Cloudflare Pages：网页界面
- Cloudflare Worker：接口、权限、任务调度和数据加密
- Cloudflare D1：保存账号、任务和运行记录
- GitHub Actions：执行 Telegram 登录和普通自动消息任务
- Telegram API：连接 Telegram 账号
- 可选 VPS Listener：保持 Telegram 长连接并运行管理员实时功能

> 本项目不是 Telegram 官方产品，也不是 Fork 后立即可用的一键项目。第一次部署需要配置 Cloudflare、GitHub OAuth、GitHub Actions、D1 和 Telegram API 凭据。请严格按照下面的顺序操作，不要跳步。

## 可以实现什么

完成基础部署后，可以通过网页完成：

- 使用 GitHub 登录平台
- 使用手机号连接 Telegram 账号
- 输入 Telegram 验证码和二步验证密码
- 创建一次性或定时消息任务
- 向好友、群组、频道或机器人发送消息
- 自动读取账号中的好友和群组并选择发送对象
- 发送文字、图片、视频、语音、音频和普通文件
- 复制已有 Telegram 消息
- 向机器人发送命令
- 等待机器人回复并点击指定按钮
- 使用每日、每周、每小时、间隔时间和 Cron 计划
- 手动执行、启用、停用、复制和删除任务
- 查看任务状态、执行时间、重试次数和脱敏日志

完成可选的 VPS Listener 部署后，管理员还可以使用：

- Telegram 账号连接状态检测
- 24 小时关键词自动回复
- 全天候消息监听
- 自动选择某个好友或群组作为回复、监听范围
- 选择全部适用会话作为自动回复范围
- 自动同步账号中的好友、群组、超级群组和频道目录
- 自动识别机器人回复和可点击按钮
- 由常驻 Listener 执行启用了实时规则账号的定时任务

## 使用前需要准备

基础部署需要：

1. 一个 GitHub 账号
2. 一个 Cloudflare 账号
3. 一个 Telegram 账号
4. Telegram `API_ID` 和 `API_HASH`
5. 一个可以创建 GitHub Fine-grained Token 的 GitHub 账号
6. 一个 Cloudflare API Token

基础版本不需要 VPS。

要体验管理员 24 小时实时功能，还需要：

7. 一台长期在线并且可以访问 Telegram 的 VPS
8. VPS 上安装 Docker Engine 和 Docker Compose
9. 一个随机生成的 `LISTENER_API_TOKEN`

邮箱注册、邮箱验证码和找回密码属于可选配置。第一次部署建议先只使用 GitHub 登录，确认基础功能正常后再配置邮箱功能。

## 整体架构

```text
浏览器
  │
  ▼
Cloudflare Pages
  网页界面
  │
  ▼
Cloudflare Worker
  登录、权限、加密、任务调度
  │
  ├── Cloudflare D1
  │     账号、任务、运行记录
  │
  ├── GitHub Actions
  │       Telegram 登录和普通短任务
  │
  └── 可选 VPS Listener
          24 小时连接、自动回复、消息监听和实时任务
                    │
                    ▼
                 Telegram
```

Cloudflare Pages 本身不会直接连接 Telegram。

Telegram 手机号登录和普通自动消息任务，由 GitHub Actions 中的 Python Runner 执行。需要长期保持 Telegram 在线的功能由 VPS Listener 执行。

# 基础部署

## 第一步：Fork 仓库

打开本仓库，点击右上角的 `Fork`，复制到自己的 GitHub 账号。

Fork 完成后，后续所有操作都在你自己的仓库中完成。

建议先不要修改程序代码，只修改部署配置。

## 第二步：创建 Cloudflare D1 数据库

进入 Cloudflare 控制台：

```text
Storage & Databases
→ D1 SQL Database
→ Create database
```

数据库名称建议填写：

```text
telegram-checkin
```

创建完成后，复制数据库的 ID。

打开：

```text
worker/wrangler.toml
```

修改：

```toml
[[d1_databases]]
binding = "DB"
database_name = "telegram-checkin"
database_id = "替换成你的D1数据库ID"
migrations_dir = "migrations"
```

不要修改 `binding = "DB"`。

## 第三步：确定 Worker 和网页项目名称

建议给自己的 Worker 和 Pages 项目设置唯一名称。

例如：

```text
Worker 名称：my-telegram-worker
Pages 名称：my-telegram-panel
```

### 修改 Worker 名称

打开：

```text
worker/wrangler.toml
```

修改：

```toml
name = "my-telegram-worker"
```

### 修改 Pages 配置

打开：

```text
admin/wrangler.toml
```

修改为：

```toml
name = "my-telegram-panel"
pages_build_output_dir = "."
compatibility_date = "2026-07-01"

[vars]
CANONICAL_HOST = "my-telegram-panel.pages.dev"

[[services]]
binding = "CONTROL_PLANE"
service = "my-telegram-worker"
```

其中：

- `CANONICAL_HOST` 是网页域名，不要加 `https://`
- `service` 必须和 Worker 名称完全相同
- `CONTROL_PLANE` 不要修改

再打开：

```text
.github/workflows/deploy-admin.yml
```

找到：

```text
--project-name=telegram-checkin-admin
```

改成自己的 Pages 项目名称：

```text
--project-name=my-telegram-panel
```

## 第四步：创建 Cloudflare Pages 项目

进入 Cloudflare 控制台：

```text
Workers & Pages
→ Create application
→ Pages
→ Direct Upload
```

创建一个 Direct Upload 项目。

项目名称必须与前面设置的 Pages 名称相同，例如：

```text
my-telegram-panel
```

创建后会得到类似下面的网页地址：

```text
https://my-telegram-panel.pages.dev
```

先记录这个地址。暂时不需要手工上传文件，后面由 GitHub Actions 自动部署。

## 第五步：修改 Worker 的公开配置

打开：

```text
worker/wrangler.toml
```

修改 `[vars]` 部分：

```toml
[vars]
GITHUB_OWNER = "你的GitHub用户名"
GITHUB_REPO = "Telegramautomaticcheck-in"
GITHUB_REF = "main"

TASK_RUNNER_WORKFLOW_FILE = "task-runner.yml"
LOGIN_WORKFLOW_FILE = "telegram-login.yml"

RUNNER_OIDC_AUDIENCE = "https://my-telegram-worker.你的Workers子域.workers.dev/api/runner"

ADMIN_ORIGIN = "https://my-telegram-panel.pages.dev"
ADMIN_GITHUB_LOGIN = "你的GitHub用户名"
ADMIN_GITHUB_USER_ID = "你的GitHub数字ID"

ADMIN_SESSION_TTL_SECONDS = "604800"
PASSWORD_HASH_ITERATIONS = "100000"
PUBLIC_PASSWORD_AUTH_MODE = "secure"
SCHEDULE_DISPATCH_LEAD_SECONDS = "120"
```

必须替换：

- `GITHUB_OWNER`
- `RUNNER_OIDC_AUDIENCE`
- `ADMIN_ORIGIN`
- `ADMIN_GITHUB_LOGIN`
- `ADMIN_GITHUB_USER_ID`

### 管理员身份如何确定

系统不会把第一个注册用户自动设为管理员。

只有通过 GitHub OAuth 登录，并且 GitHub 数字 ID 与 `ADMIN_GITHUB_USER_ID` 完全相同的账号，才会获得管理员权限。

因此部署者必须把：

```toml
ADMIN_GITHUB_LOGIN = "你的GitHub用户名"
ADMIN_GITHUB_USER_ID = "你的GitHub数字ID"
```

替换成自己的信息，并且第一次使用时通过同一个 GitHub 账号登录。

邮箱注册账号不会自动成为管理员。

### 查询自己的 GitHub 数字 ID

在终端执行：

```bash
curl https://api.github.com/users/你的GitHub用户名
```

返回结果中的：

```json
"id": 123456789
```

就是需要填写的 GitHub 数字 ID。

## 第六步：创建 GitHub OAuth App

进入 GitHub：

```text
Settings
→ Developer settings
→ OAuth Apps
→ New OAuth App
```

填写：

```text
Application name:
Telegram Automatic Message

Homepage URL:
https://my-telegram-panel.pages.dev

Authorization callback URL:
https://my-telegram-panel.pages.dev/api/auth/github/callback
```

创建后会获得：

```text
Client ID
Client Secret
```

OAuth 回调地址必须与 `ADMIN_ORIGIN` 使用同一个域名，否则 GitHub 登录会失败。

## 第七步：创建 GitHub Token

创建一个 GitHub Fine-grained Personal Access Token。

该 Token 只需要访问你 Fork 后的仓库，并允许派发 GitHub Actions 工作流。

建议设置：

```text
Repository access:
Only select repositories

选择：
Telegramautomaticcheck-in

Repository permissions:
Actions: Read and write
Contents: Read
```

创建完成后复制 Token。这个 Token 后面作为 Worker Secret：

```text
GITHUB_TOKEN
```

不要把 Token 写入仓库文件。

## 第八步：创建 Cloudflare API Token

在 Cloudflare 创建一个 API Token，用于 GitHub Actions 部署：

- Cloudflare Worker
- D1 数据库
- Cloudflare Pages

该 Token 必须有目标账号下对应资源的编辑权限。

同时复制 Cloudflare：

```text
Account ID
```

## 第九步：配置 GitHub Actions Secrets

进入 Fork 后的仓库：

```text
Settings
→ Secrets and variables
→ Actions
```

在 `Secrets` 中添加：

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
PASSWORD_PEPPER
```

### 生成 PASSWORD_PEPPER

执行：

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

把输出保存为：

```text
PASSWORD_PEPPER
```

这个值部署后不要随意更换，否则已有邮箱密码可能失效。

## 第十步：配置 GitHub Actions Variables

进入：

```text
Settings
→ Secrets and variables
→ Actions
→ Variables
```

添加：

```text
WORKER_URL
WORKER_OIDC_AUDIENCE
ADMIN_URL
```

示例：

```text
WORKER_URL
https://my-telegram-worker.你的Workers子域.workers.dev
```

```text
WORKER_OIDC_AUDIENCE
https://my-telegram-worker.你的Workers子域.workers.dev/api/runner
```

```text
ADMIN_URL
https://my-telegram-panel.pages.dev
```

`WORKER_OIDC_AUDIENCE` 必须和 `worker/wrangler.toml` 中的 `RUNNER_OIDC_AUDIENCE` 完全一致。

## 第十一步：第一次部署 Worker

进入：

```text
Actions
→ Deploy Cloudflare Worker
→ Run workflow
```

第一次运行选择：

```text
deployment_mode: bootstrap
```

`bootstrap` 只用于第一次创建 Worker。

工作流会：

1. 运行测试
2. 执行 D1 migrations
3. 创建 Cloudflare Worker
4. 检查 `/health`

成功后进入 Cloudflare：

```text
Workers & Pages
→ 你的 Worker
→ Settings
→ Variables and Secrets
```

## 第十二步：配置 Worker Secrets

在 Cloudflare Worker 中添加以下加密 Secret：

```text
GITHUB_TOKEN
SECRET_ROOT_KEY
GITHUB_OAUTH_CLIENT_ID
GITHUB_OAUTH_CLIENT_SECRET
```

### GITHUB_TOKEN

填写前面创建的 GitHub Fine-grained Token。

### SECRET_ROOT_KEY

生成一个 32 字节 Base64 密钥：

```bash
openssl rand -base64 32
```

把完整输出保存为：

```text
SECRET_ROOT_KEY
```

该值用于加密 Telegram Session 和其他敏感数据。丢失这个值后，已保存的加密数据将无法解密。

### GITHUB_OAUTH_CLIENT_ID

填写 GitHub OAuth App 的 Client ID。

### GITHUB_OAUTH_CLIENT_SECRET

填写 GitHub OAuth App 的 Client Secret。

这些值必须添加为加密 Secret，不要添加到普通 Variables。

## 第十三步：正式部署 Worker

再次进入：

```text
Actions
→ Deploy Cloudflare Worker
→ Run workflow
```

选择：

```text
deployment_mode: fresh_install
```

工作流会：

1. 检查代码
2. 应用 D1 migrations
3. 部署完整 Worker
4. 检查 `/health`
5. 检查 `/ready`
6. 检查登录配置

成功后访问：

```text
https://你的Worker域名/health
```

应看到：

```json
{
  "ok": true
}
```

然后访问：

```text
https://你的Worker域名/ready
```

也应返回正常状态。

以后升级 Worker 时继续使用 `fresh_install`，不要再次使用 `bootstrap`。

## 第十四步：部署网页

进入：

```text
Actions
→ Deploy Cloudflare Pages Admin
→ Run workflow
```

工作流会：

1. 运行网页测试
2. 将 `admin/` 上传到 Cloudflare Pages
3. 使用 `CONTROL_PLANE` Service Binding 连接 Worker
4. 检查网页首页
5. 检查 `/api/auth/config`

部署成功后打开：

```text
https://my-telegram-panel.pages.dev
```

如果网页可以打开，但数据接口报错，检查 `admin/wrangler.toml` 中：

```toml
service = "my-telegram-worker"
```

是否和真实 Worker 名称完全一致。

## 第十五步：第一次登录和初始化

打开网页后，使用前面写入 `ADMIN_GITHUB_USER_ID` 的 GitHub 账号登录。

登录后，该账号应获得管理员角色。

进入设置页面，填写从 Telegram 开发平台申请的：

```text
API_ID
API_HASH
```

这组凭据是整个平台连接 Telegram 所必需的。普通用户新增账号时不需要重复填写，但部署者必须先完成一次平台初始化。

不要公开：

- `API_HASH`
- Telegram Session
- Telegram 验证码
- 二步验证密码
- GitHub Token
- Cloudflare Token
- OAuth Client Secret

## 第十六步：连接 Telegram 账号

进入：

```text
Telegram 账号
→ 新增账号
```

按照网页提示完成：

```text
输入手机号
→ Telegram 发送验证码
→ 在网页输入验证码
→ 如有二步验证，输入二步验证密码
→ 等待账号显示“已连接”
```

Telegram 验证码可能发送到已经登录的 Telegram 客户端中，不一定通过短信发送。

连接成功后，Session 会由 Worker 加密保存。

## 第十七步：创建第一个任务

进入：

```text
自动消息
→ 新增任务
```

建议第一次创建简单测试任务：

```text
任务名称：测试消息
Telegram 账号：选择刚刚连接的账号
任务类型：发送文字消息
发送对象：选择“收藏夹”或 me
消息内容：测试成功
执行计划：设置为几分钟后的时间
```

保存后先点击：

```text
手动执行
```

然后进入：

```text
执行记录
```

确认任务成功后，再配置群组、机器人、图片、视频、按钮任务或复杂 Cron。

# 可选：部署管理员 24 小时实时功能

基础任务可以只使用 Cloudflare 和 GitHub Actions，不需要 VPS。

以下功能需要 VPS Listener 长期在线：

- 24 小时关键词自动回复
- 全天候消息监听
- Telegram 账号连接检测
- 自动同步好友和群组目录
- 自动识别机器人回复与按钮
- 实时账号的定时任务执行

## 1. 确认管理员账号正确

检查 `worker/wrangler.toml`：

```toml
ADMIN_GITHUB_LOGIN = "你的GitHub用户名"
ADMIN_GITHUB_USER_ID = "你的GitHub数字ID"
```

必须使用对应的 GitHub 账号登录平台。

如果使用其他 GitHub 账号或邮箱账号登录，只会获得普通用户工作区，不会获得管理员实时功能。

## 2. 准备 VPS

建议配置：

- Ubuntu 22.04、Ubuntu 24.04 或 Debian 12
- 至少 1 核 CPU
- 至少 1 GB 内存
- 可以访问 Telegram、Cloudflare Worker、GitHub 和 PyPI
- 可以长期保持开机
- 拥有 SSH 登录权限

如果 VPS 所在网络无法访问 Telegram，Listener 即使启动成功也无法工作。

## 3. 生成 Listener Token

在自己的电脑或 VPS 执行：

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

复制生成的随机值。

不要把它提交到仓库、发送到 Issue 或显示在截图中。

## 4. 将 Token 添加到 GitHub Secret

进入：

```text
GitHub 仓库
→ Settings
→ Secrets and variables
→ Actions
→ Secrets
```

新增：

```text
LISTENER_API_TOKEN
```

值填写刚才生成的随机 Token。

## 5. 重新部署 Worker

进入：

```text
Actions
→ Deploy Cloudflare Worker
→ Run workflow
```

选择：

```text
deployment_mode: fresh_install
```

部署工作流会把 `LISTENER_API_TOKEN` 安全写入 Worker Secret。

部署成功后访问：

```text
https://你的Worker域名/ready
```

应看到类似状态：

```json
{
  "ok": true,
  "checks": {
    "realtime_listener": "configured"
  }
}
```

`configured` 只表示 Worker 已经配置 Token，不代表 VPS Listener 已经在线。

## 6. 在 VPS 安装 Docker

通过 SSH 登录 VPS：

```bash
ssh root@你的VPS地址
```

安装基础工具：

```bash
apt update
apt install -y ca-certificates curl git
```

安装 Docker：

```bash
curl -fsSL https://get.docker.com -o get-docker.sh
sh get-docker.sh
```

确认：

```bash
docker --version
docker compose version
```

使用非 root 用户部署时，需要确保该用户可以直接执行 `docker` 命令。

## 7. 下载自己的 Fork

在 VPS 执行：

```bash
git clone https://github.com/你的GitHub用户名/Telegramautomaticcheck-in.git
cd Telegramautomaticcheck-in/listener
cp .env.example .env
```

必须克隆自己的 Fork，不要继续使用原仓库所有者的部署配置。

## 8. 编辑 Listener 配置

打开：

```bash
nano .env
```

填写：

```text
WORKER_URL=https://你的Worker域名
LISTENER_API_TOKEN=与GitHub Secret完全相同的随机Token
LISTENER_INSTANCE_ID=listener-vps-1
LISTENER_LABEL=主监听服务器
LISTENER_SYNC_SECONDS=30
LISTENER_HEARTBEAT_SECONDS=60
LISTENER_INSPECTION_SECONDS=4
LISTENER_TASK_SECONDS=2
LISTENER_MEDIA_UPLOAD_SECONDS=2
```

注意：

- `WORKER_URL` 不要带最后的 `/`
- `LISTENER_API_TOKEN` 必须与 GitHub Secret 中的值完全一致
- Token 前后不能有空格
- `LISTENER_INSTANCE_ID` 应保持固定，不要每次重启随机生成
- 多台 VPS 同时部署时，每台必须使用不同的 `LISTENER_INSTANCE_ID`

保存 `nano`：

```text
Ctrl + O
Enter
Ctrl + X
```

## 9. 启动 Listener

执行：

```bash
docker compose up -d --build
```

查看容器：

```bash
docker compose ps
```

查看实时日志：

```bash
docker compose logs --tail=100 -f telegram-listener
```

看到持续心跳、同步成功，并且没有鉴权错误后，说明 Listener 已经开始连接 Worker。

## 10. 在网页确认 Listener 在线

使用管理员 GitHub 账号重新登录网页。

进入设置页面，查看 24 小时实时服务状态。

只有同时满足下面条件，管理员功能才可以运行：

1. 当前网页账号是管理员
2. VPS Listener 容器正在运行
3. Listener Token 与 Worker Token 相同
4. VPS 可以访问 Telegram
5. 至少有一个 Telegram 账号显示“已连接”

如果 `/ready` 显示 `configured`，但网页仍显示 Listener 离线，检查 VPS 日志和 Token 是否一致。

## 11. 创建第一条自动回复规则

进入：

```text
自动消息
→ 实时自动化规则
→ 创建关键词自动回复
```

设置：

```text
Telegram 账号：选择已连接账号
自动回复对象：选择某个好友、群组或“全部可回复会话”
触发条件：消息包含关键词
关键词：测试
自动回复内容：已收到测试消息
```

保存后等待约 30 秒，让 Listener 同步新规则。

然后使用另一个 Telegram 账号，在选择的会话中发送：

```text
测试
```

如果收到自动回复，说明管理员实时功能已经运行。

自动回复默认不会回复：

- 当前账号自己发送的消息
- 机器人发送的消息
- 无法发送消息的只读会话

同时存在冷却和频率限制，以避免循环回复和刷屏。

## 12. 创建第一条消息监听规则

进入：

```text
自动消息
→ 实时自动化规则
→ 创建消息监听
```

可以选择：

- 某个好友
- 某个机器人
- 某个群组
- 某个超级群组
- 某个频道
- 全部会话

保存后等待 Listener 同步规则，再从目标会话发送测试内容。

## 13. 更新 Listener

仓库更新后，在 VPS 执行：

```bash
cd ~/Telegramautomaticcheck-in
git pull
docker compose -f listener/docker-compose.yml up -d --build
```

如果仓库实际位于其他目录，请替换路径。

在 `listener/` 目录内时，也可以执行：

```bash
git pull
docker compose up -d --build
```

## 14. 停止 Listener

在 `listener/` 目录执行：

```bash
docker compose down
```

停止后：

- 普通 GitHub Actions 任务仍可继续运行
- 24 小时自动回复和消息监听停止
- Listener 离线期间的新消息不会全部补处理

## 15. 可选使用 GitHub Actions 自动部署 VPS

仓库还包含：

```text
.github/workflows/deploy-listener.yml
```

它可以通过 SSH 自动更新 VPS Listener。

第一次部署建议先按照本文手工部署，确认 Worker、Token、Docker 和网络都正常后，再参考：

```text
listener/README.md
```

配置自动部署所需的 SSH Key、Known Hosts 和 VPS 地址。

# 可选：开启邮箱注册和找回密码

基础部署建议先使用 GitHub 登录。

确认 GitHub 登录、Telegram 登录和任务执行正常后，再配置邮箱功能。

邮箱功能需要同时准备：

```text
TURNSTILE_SITE_KEY
TURNSTILE_SECRET_KEY
RESEND_API_KEY
AUTH_EMAIL_FROM
```

在 GitHub Actions 中配置：

### Variables

```text
TURNSTILE_SITE_KEY
AUTH_EMAIL_FROM
```

### Secrets

```text
TURNSTILE_SECRET_KEY
RESEND_API_KEY
```

`AUTH_EMAIL_FROM` 必须使用邮件服务已经验证的自定义发件域名。

例如：

```text
Telegram 自动消息 <login@auth.example.com>
```

四项配置必须同时存在。只填写一部分会导致 Worker 部署失败。

配置完成后重新运行：

```text
Deploy Cloudflare Worker
deployment_mode: fresh_install
```

# 常见问题

## 1. 网页能打开，但所有数据加载失败

检查：

- Worker 是否部署成功
- `/health` 是否正常
- `/ready` 是否正常
- `CONTROL_PLANE` 是否绑定到正确 Worker
- `ADMIN_ORIGIN` 是否为当前网页域名

## 2. GitHub 登录后返回错误

检查：

- OAuth Homepage URL
- OAuth Callback URL
- `ADMIN_ORIGIN`
- `GITHUB_OAUTH_CLIENT_ID`
- `GITHUB_OAUTH_CLIENT_SECRET`

回调地址必须是：

```text
https://你的网页域名/api/auth/github/callback
```

## 3. 登录后没有管理员功能

检查：

- 是否使用 GitHub 登录，而不是邮箱登录
- 登录 GitHub 账号的数字 ID 是否与 `ADMIN_GITHUB_USER_ID` 一致
- `worker/wrangler.toml` 是否仍保留原仓库所有者的信息
- 修改配置后是否重新部署 Worker
- 是否退出旧会话后重新登录

管理员不是按照注册顺序确定的。

## 4. Telegram 手机号登录没有反应

检查：

- GitHub Actions 是否启用
- `GITHUB_TOKEN` 是否有 Actions 写权限
- `WORKER_URL` 是否正确
- `WORKER_OIDC_AUDIENCE` 是否正确
- Telegram `API_ID` 和 `API_HASH` 是否已初始化
- `telegram-login.yml` 是否被禁用

## 5. 任务一直排队

检查：

- GitHub Actions 是否有新的运行记录
- `task-runner.yml` 是否能够启动
- Telegram 账号是否仍显示“已连接”
- GitHub Token 是否仍然有效
- Worker `/ready` 是否正常

## 6. Listener 显示离线

检查：

```bash
docker compose ps
docker compose logs --tail=200 telegram-listener
```

重点确认：

- `WORKER_URL` 是否正确
- Worker 是否已经重新部署并配置 `LISTENER_API_TOKEN`
- VPS `.env` 中的 Token 是否完全一致
- VPS 是否能访问 Worker 和 Telegram
- 容器是否持续重启

## 7. 自动回复规则保存后没有生效

检查：

- Listener 是否在线
- 规则是否启用
- 账号是否显示“已连接”
- 发送消息的人是否为真人账号
- 会话是否属于规则选择范围
- 关键词大小写设置是否正确
- 是否等待了约 30 秒让 Listener 同步

## 8. 任务没有严格准点执行

GitHub Actions 不是硬实时执行器。

即使任务中填写了秒，仍可能受到：

- GitHub Actions 排队
- Cloudflare Cron 调度
- Telegram 网络
- 外部机器人响应速度

因此 Cron 中的秒表示目标时间，不代表绝对准点。

## 9. 邮箱注册入口没有开放

说明以下配置至少有一项缺失：

```text
TURNSTILE_SITE_KEY
TURNSTILE_SECRET_KEY
RESEND_API_KEY
AUTH_EMAIL_FROM
```

不需要邮箱注册时，可以继续使用 GitHub 登录。

## 10. D1 migration 失败

检查：

- `database_id` 是否正确
- Cloudflare API Token 是否有 D1 编辑权限
- D1 binding 是否仍为 `DB`
- 不要手工跳过 migrations

# 更新项目

仓库有新版本后，可以把上游更新同步到自己的 Fork。

更新后建议先查看改动范围：

- 修改了 `worker/`：运行 `Deploy Cloudflare Worker`
- 修改了 `admin/`：运行 `Deploy Cloudflare Pages Admin`
- 修改了 `runner/`：下一次 GitHub Actions 会使用新代码
- 修改了 `listener/`：在 VPS 执行 `git pull` 和 `docker compose up -d --build`
- 修改了 migrations：必须重新运行 Worker 部署

Worker 更新使用：

```text
deployment_mode: fresh_install
```

部署前不要删除已有 D1 数据库。

# 安全提醒

请勿把以下内容提交到 GitHub 或发送到 Issue、聊天和截图：

```text
Cloudflare API Token
GitHub Token
GitHub OAuth Client Secret
SECRET_ROOT_KEY
PASSWORD_PEPPER
LISTENER_API_TOKEN
Telegram API_HASH
Telegram Session
Telegram 验证码
Telegram 二步验证密码
```

建议：

- 仓库公开前检查历史提交
- Token 只授予必要权限
- 定期撤销不再使用的 Token
- 不要在截图中显示 Secret
- 不要把真实 `.env` 文件提交到仓库
- 不要随意更换 `SECRET_ROOT_KEY`
- VPS 不需要开放额外的 Web 管理端口
- 定期更新 Docker、系统安全补丁和仓库代码

# 本地运行测试

在仓库根目录执行：

```bash
python -m unittest discover -s runner/tests -p 'test_*.py' -v
python -m unittest discover -s listener/tests -p 'test_*.py' -v
python -m compileall -q listener
npm test --prefix worker
npm test --prefix admin
node --test tools/*.test.mjs
```

测试通过只能说明仓库代码契约没有明显回归，不代表 Cloudflare、GitHub、Telegram、VPS 和网络配置一定正确。

生产部署后仍需实际测试：

1. GitHub 管理员登录
2. Telegram 手机号登录
3. 手动执行一条测试任务
4. 查看执行记录
5. 等待一条定时任务执行
6. 部署 VPS 后确认 Listener 在线
7. 使用另一个 Telegram 账号测试自动回复或监听规则

# 仓库目录

```text
admin/        Cloudflare Pages 网页
worker/       Cloudflare Worker 和 D1 migrations
runner/       GitHub Actions Telegram 任务执行器
listener/     VPS 常驻 Telegram Listener
docs/         补充部署和安全说明
.github/      GitHub Actions 工作流
```

只使用普通定时任务时，完成 Pages、Worker、D1、GitHub Actions 和 Telegram 配置即可。

要体验管理员 24 小时实时功能，再完成本文中的 VPS Listener 部署。