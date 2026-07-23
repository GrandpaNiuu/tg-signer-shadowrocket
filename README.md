# Telegram 自动消息平台

一个可以通过网页管理 Telegram 账号和自动消息任务的开源项目。

你可以在网页中登录自己的 Telegram 账号，然后创建定时消息、发送命令、发送图片或视频、执行机器人按钮任务，并查看每次任务的执行结果。

本项目使用：

- Cloudflare Pages：网页界面
- Cloudflare Worker：接口、权限、任务调度和数据加密
- Cloudflare D1：保存账号、任务和运行记录
- GitHub Actions：执行 Telegram 登录和自动消息任务
- Telegram API：连接 Telegram 账号

> 本项目不是 Telegram 官方产品，也不是 Fork 后立即可用的一键项目。第一次部署需要配置 Cloudflare、GitHub OAuth、GitHub Actions、D1 和 Telegram API 凭据。请严格按照下面的顺序操作，不要跳步。

## 可以实现什么

部署完成后，可以通过网页完成：

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

## 使用前需要准备

开始前需要准备以下账号和资料：

1. 一个 GitHub 账号
2. 一个 Cloudflare 账号
3. 一个 Telegram 账号
4. Telegram `API_ID` 和 `API_HASH`
5. 一个可以创建 GitHub Fine-grained Token 的 GitHub 账号
6. 一个 Cloudflare API Token

基础版本不需要 VPS。

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
  └── GitHub Actions
          │
          ▼
       Telegram
```

Cloudflare Pages 本身不会直接连接 Telegram。

Telegram 手机号登录和普通自动消息任务，由 GitHub Actions 中的 Python Runner 执行。

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

修改下面的内容：

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

创建后，你会得到类似下面的网页地址：

```text
https://my-telegram-panel.pages.dev
```

先记录这个地址。

暂时不需要手工上传文件，后面由 GitHub Actions 自动部署。

## 第五步：修改 Worker 的公开配置

打开：

```text
worker/wrangler.toml
```

修改 `[vars]` 部分。

示例：

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

以下内容必须替换：

- `GITHUB_OWNER`
- `RUNNER_OIDC_AUDIENCE`
- `ADMIN_ORIGIN`
- `ADMIN_GITHUB_LOGIN`
- `ADMIN_GITHUB_USER_ID`

### 查询自己的 GitHub 数字 ID

可以在终端执行：

```bash
curl https://api.github.com/users/你的GitHub用户名
```

返回结果中的：

```json
"id": 123456789
```

就是需要填写的 GitHub 数字 ID。

`ADMIN_GITHUB_LOGIN` 和 `ADMIN_GITHUB_USER_ID` 用来确认部署所有者身份。不要填写其他人的账号信息。

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

请保存好，后面需要写入 Cloudflare Worker Secrets。

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

创建完成后复制 Token。

这个 Token 后面作为 Cloudflare Worker Secret：

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

同时在 Cloudflare 控制台复制你的：

```text
Account ID
```

## 第九步：配置 GitHub Actions Secrets

进入自己 Fork 后的仓库：

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

其中：

```text
CLOUDFLARE_API_TOKEN
```

填写刚才创建的 Cloudflare API Token。

```text
CLOUDFLARE_ACCOUNT_ID
```

填写 Cloudflare Account ID。

### 生成 PASSWORD_PEPPER

在电脑或 VPS 终端执行：

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

把结果保存为：

```text
PASSWORD_PEPPER
```

这个值部署后不要随意更换，否则已有邮箱密码可能失效。

## 第十步：配置 GitHub Actions Variables

还是在：

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

进入 GitHub 仓库的：

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

该工作流会：

1. 运行测试
2. 执行 D1 migrations
3. 创建 Cloudflare Worker
4. 检查 `/health`

运行成功后，进入 Cloudflare：

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

填写规则：

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

该值用于加密 Telegram Session 和其他敏感数据。

丢失这个值后，已保存的加密数据将无法解密。

### GITHUB_OAUTH_CLIENT_ID

填写 GitHub OAuth App 的 Client ID。

### GITHUB_OAUTH_CLIENT_SECRET

填写 GitHub OAuth App 的 Client Secret。

不要把这些值添加到普通 Variables，必须选择加密的 Secret。

## 第十三步：正式部署 Worker

再次进入：

```text
Actions
→ Deploy Cloudflare Worker
→ Run workflow
```

这次选择：

```text
deployment_mode: fresh_install
```

工作流会：

1. 再次检查代码
2. 应用 D1 migrations
3. 部署完整 Worker
4. 检查 `/health`
5. 检查 `/ready`
6. 检查登录配置

成功后可以访问：

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

以后升级 Worker 时继续使用：

```text
fresh_install
```

不要再次使用 `bootstrap`。

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

如果网页可以打开，但数据接口报错，优先检查：

```text
admin/wrangler.toml
```

中的：

```toml
service = "my-telegram-worker"
```

是否和真实 Worker 名称完全一致。

## 第十五步：第一次登录和初始化

打开网页后，选择 GitHub 登录。

登录成功后，进入设置页面，填写从 Telegram 开发平台申请的：

```text
API_ID
API_HASH
```

这组凭据是整个平台连接 Telegram 所必需的。

普通用户在新增 Telegram 账号时不需要重复填写，但部署者必须先完成一次平台初始化。

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

Telegram 验证码可能发送到已登录的 Telegram 客户端中，不一定通过短信发送。

连接成功后，Session 会由 Worker 加密保存。

## 第十七步：创建第一个任务

进入：

```text
自动消息
→ 新增任务
```

建议第一次使用最简单的任务测试：

```text
任务名称：
测试消息

Telegram 账号：
选择刚刚连接的账号

任务类型：
发送文字消息

发送对象：
选择“收藏夹”或 me

消息内容：
测试成功

执行计划：
设置为几分钟后的时间
```

保存后可以先点击：

```text
手动执行
```

然后进入：

```text
执行记录
```

查看结果。

任务执行成功后，再配置群组、机器人、图片、视频、按钮任务或复杂 Cron。

## 可选：开启邮箱注册和找回密码

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

`AUTH_EMAIL_FROM` 必须使用邮件服务中已经验证的发件域名。

例如：

```text
Telegram 自动消息 <login@auth.example.com>
```

四项配置必须同时存在。只填写一部分会导致 Worker 部署失败。

配置完成后，重新运行：

```text
Deploy Cloudflare Worker
deployment_mode: fresh_install
```

## 常见问题

### 1. 网页能打开，但所有数据加载失败

检查：

- Worker 是否部署成功
- `/health` 是否正常
- `/ready` 是否正常
- `CONTROL_PLANE` 是否绑定到正确 Worker
- `ADMIN_ORIGIN` 是否为当前网页域名

### 2. GitHub 登录后返回错误

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

### 3. Telegram 手机号登录没有反应

检查：

- GitHub Actions 是否启用
- `GITHUB_TOKEN` 是否有 Actions 写权限
- `WORKER_URL` 是否正确
- `WORKER_OIDC_AUDIENCE` 是否正确
- Telegram `API_ID` 和 `API_HASH` 是否已经初始化
- `telegram-login.yml` 是否被禁用

### 4. 任务一直排队

检查：

- GitHub Actions 是否有新的运行记录
- `task-runner.yml` 是否能够启动
- Telegram 账号是否仍显示“已连接”
- GitHub Token 是否仍然有效
- Worker `/ready` 是否正常

### 5. 任务没有严格准点执行

GitHub Actions 不是硬实时执行器。

即使任务中填写了秒，仍可能受到以下因素影响：

- GitHub Actions 排队
- Cloudflare Cron 调度
- Telegram 网络
- 外部机器人响应速度

因此 Cron 中的秒表示目标时间，不代表绝对准点。

### 6. 邮箱注册入口没有开放

说明以下配置至少有一项缺失：

```text
TURNSTILE_SITE_KEY
TURNSTILE_SECRET_KEY
RESEND_API_KEY
AUTH_EMAIL_FROM
```

不需要邮箱注册时，可以继续使用 GitHub 登录。

### 7. D1 migration 失败

检查：

- `database_id` 是否正确
- Cloudflare API Token 是否有 D1 编辑权限
- D1 binding 是否仍为 `DB`
- 不要手工跳过 migrations

## 更新项目

仓库有新版本后，可以把上游更新同步到自己的 Fork。

更新后建议先查看改动范围：

- 修改了 `worker/`：运行 `Deploy Cloudflare Worker`
- 修改了 `admin/`：运行 `Deploy Cloudflare Pages Admin`
- 修改了 `runner/`：通常不需要单独部署，下一次 GitHub Actions 会使用新代码
- 修改了 migrations：必须重新运行 Worker 部署

Worker 更新使用：

```text
deployment_mode: fresh_install
```

部署前不要删除已有 D1 数据库。

## 安全提醒

请勿把以下内容提交到 GitHub 或发送到 Issue、聊天和截图：

```text
Cloudflare API Token
GitHub Token
GitHub OAuth Client Secret
SECRET_ROOT_KEY
PASSWORD_PEPPER
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

## 本地运行测试

在仓库根目录执行：

```bash
python -m unittest discover -s runner/tests -p 'test_*.py' -v
npm test --prefix worker
npm test --prefix admin
node --test tools/*.test.mjs
```

测试通过只能说明仓库代码契约没有明显回归，不代表 Cloudflare、GitHub、Telegram 和网络配置一定正确。

生产部署后仍需实际测试：

1. GitHub 登录
2. Telegram 手机号登录
3. 手动执行一条测试任务
4. 查看执行记录
5. 等待一条定时任务执行

## 仓库目录

```text
admin/        Cloudflare Pages 网页
worker/       Cloudflare Worker 和 D1 migrations
runner/       GitHub Actions Telegram 任务执行器
listener/     可选的常驻执行组件
docs/         补充部署和安全说明
.github/      GitHub Actions 工作流
```

基础使用只需要完成本文中的 Pages、Worker、D1、GitHub Actions 和 Telegram 配置。
