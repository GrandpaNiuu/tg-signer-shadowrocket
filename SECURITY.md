# 安全策略

## 支持范围

本项目当前以 `main` 分支的最新版本为主要支持范围。历史提交、个人分支以及未经维护者确认的第三方部署不保证获得安全修复。

## 报告安全问题

请不要在公开 Issue、Discussion、Pull Request 或日志中提交以下内容：

- Telegram Session、验证码、2FA 密码、API Hash
- Cloudflare、GitHub、Resend 或其他服务的 Token/Secret
- D1 数据库导出、用户邮箱、手机号或其他个人数据
- 可直接复现账号接管、跨用户访问、任意任务执行或秘密泄露的完整利用细节

发现安全问题时，请优先通过 GitHub Security Advisory 的私密报告功能联系维护者。报告应尽量包含：

1. 受影响的模块、接口或 workflow。
2. 复现条件与最小复现步骤。
3. 实际影响与可能影响的用户范围。
4. 是否已经在公开环境中出现。
5. 建议修复方式（如有）。

请先删除或替换所有真实凭据与个人数据，再提供日志、请求或截图。

## 响应原则

维护者会按影响等级处理：

- 严重：Session、Secret 或管理员权限泄露；跨用户数据访问；任意代码或任意任务执行。
- 高：认证绕过、OIDC 校验绕过、任务重复发送或不可控派发。
- 中：敏感信息出现在日志、错误响应或前端缓存中。
- 低：仅影响可用性、文档或需要非常特殊条件才能触发的问题。

在完成修复、部署和必要的凭据轮换前，请不要公开漏洞细节。

## 部署方责任

部署者必须自行保护并定期轮换以下配置：

- `SECRET_ROOT_KEY`
- `GITHUB_TOKEN`
- `GITHUB_OAUTH_CLIENT_SECRET`
- `PASSWORD_PEPPER`
- `TURNSTILE_SECRET_KEY`
- `RESEND_API_KEY`
- Cloudflare API Token

任何 Secret 都不得提交到仓库、写入 `wrangler.toml`、workflow input、构建产物或公开日志。

如果怀疑 Telegram Session 或根密钥泄露，应立即：

1. 停止相关任务与 workflow。
2. 撤销受影响 Telegram 会话。
3. 轮换根密钥和服务 Token。
4. 检查 Git 历史、Actions 日志、D1 数据和 Cloudflare 日志。
5. 在确认加密迁移方案后重新加密敏感数据。
