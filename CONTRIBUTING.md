# 贡献指南

感谢参与维护。本仓库同时包含 Cloudflare Pages 后台、Cloudflare Worker、D1 migration、GitHub Actions 和 Python Runner。修改任一部分前，请先确认完整调用链和安全边界。

## 开发原则

1. 不在数据库、workflow input、命令行参数或日志中写入明文 Session、API Hash、验证码、2FA、Token 或密码。
2. 不允许数据库配置任意 Python、Shell 或模块路径；新增 Skill 必须进入代码 allowlist。
3. 对发送结果不确定的异常使用 `ambiguous`，不得通过盲目重试制造重复消息。
4. 同一个 Telegram 账号的任务必须保持串行执行。
5. 所有用户数据查询和写入都必须带 owner/tenant 边界。
6. 数据库结构变化必须通过新的 migration 完成，不修改已经部署的历史 migration。
7. 不直接向 `main` 推送较大改动；使用独立分支和 Pull Request。

## 本地检查

提交前运行：

```bash
python -m unittest discover -s runner/tests -p 'test_*.py' -v
npm test --prefix worker
npm test --prefix admin
```

如修改了 workflow、deployment 或 migration，还应检查：

- YAML/TOML/JSON 语法。
- D1 migration 可重复部署顺序。
- Worker 与 Pages 的环境变量名称是否一致。
- workflow input 是否只包含不敏感标识符。
- 日志和错误响应是否经过脱敏。

## Pull Request 要求

PR 描述至少应包含：

- 变更目的与用户影响。
- 涉及目录和数据流。
- 安全影响。
- 数据库 migration 或部署步骤。
- 已运行的测试。
- 回滚方式。

涉及认证、Session、OIDC、加密、调度、重试、账号状态或用户隔离的改动，应提供对应测试或明确说明无法自动测试的部分。

## Commit 建议

建议使用清晰的前缀：

- `feat:` 新功能
- `fix:` 缺陷修复
- `refactor:` 不改变行为的重构
- `test:` 测试
- `docs:` 文档
- `chore:` 工程与维护
- `security:` 安全修复

## 不接受的改动

- 提交真实凭据、Session、手机号、验证码或生产数据库内容。
- 为方便调试关闭鉴权、OIDC 校验、加密或用户隔离。
- 通过自动重试处理无法确认是否已经发送的任务。
- 引入与仓库目标无关的大型框架或基础设施。
- 未说明 migration 和回滚方式的破坏性数据库修改。
