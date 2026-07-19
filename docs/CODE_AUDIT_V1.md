# Code Audit Report v1

审计范围：当前 `main` 分支中的 Cloudflare Pages 后台、Cloudflare Worker、D1 Repository、Scheduler、GitHub Actions 入口与 Python Runner 的运行边界。

本报告只针对当前仓库，不扩展到其他业务或项目。

## 结论

当前架构主链路明确：Pages → Worker → D1 → GitHub Actions → Runner → Telegram。现阶段不建议改架构，优先修复一致性、可观测性和故障恢复问题。

仓库已经具备较好的基础：

- D1 是唯一调度和配置来源。
- Scheduler 使用 dedupe key 防止同一计划时间重复创建运行。
- 同一 Telegram 账号通过 dispatch reservation 保持串行。
- 不确定发送结果使用 `ambiguous`，避免盲目重试。
- 登录状态已有集中定义。
- Worker 已有统一 `HttpError` 与顶层异常处理。

## P0：必须保持的安全与执行边界

### P0-1 不得削弱用户数据隔离

所有后台资源访问必须继续通过 `repository.forUser(identity)` 进入用户作用域。任何新增 Repository 方法都必须明确检查 `user_id`，管理员接口除外。

风险：跨用户读取或修改账号、任务、运行记录与 Secret。

验证要求：为账号、任务、运行记录各增加至少一个跨用户拒绝测试。

状态：待补充自动化测试。

### P0-2 不得对不确定发送结果自动重试

Runner 超时、连接中断或 Telegram 返回结果无法确认时必须保持 `ambiguous`，不能转换为普通失败后自动重试。

风险：重复签到、重复命令或重复消息。

验证要求：增加超时后状态断言和后续 Scheduler 不重派发测试。

状态：Runner 已有 `retryable && !ambiguous` 才重试的保护；待补充边界测试。

### P0-3 workflow input 只能包含不敏感 ID

`task-runner.yml` 和 `telegram-login.yml` 的输入必须继续只传 `run_id`、`flow_id` 等非敏感标识。Session、API Hash、验证码、2FA、代理凭据不得进入 workflow input 或命令行。

状态：已核查，当前 workflow input 仅传不敏感 ID。

## P1：整改进度

### P1-1 API 错误响应 request_id

状态：已完成。所有 Worker 响应带 `x-request-id`，错误 JSON 会补齐 `request_id`，并已有 404、405、`cf-ray` 测试。

### P1-2 `/health` 与 `/ready`

状态：已完成。`/health` 保持存活检查；`/ready` 检查 D1 和关键非敏感配置，并避免泄露内部异常和 Secret。

### P1-3 状态定义集中化

状态：进行中。已新增账号、任务运行和 dispatch 状态常量及合法性测试；关键路径硬编码替换仍在继续。

### P1-4 Scheduler reconciliation 可观测性

状态：已完成基础部分。Scheduler summary 与 Cron 结构化日志已输出：

- `cancelled_unavailable`
- `reset_dispatches`
- `expired_runs`
- `expired_queued`

并已有 reconciliation 测试。

### P1-5 调度失败稳定错误码

状态：已完成基础分类。GitHub dispatch 失败分为：

- `github_dispatch_http_error`
- `github_dispatch_network_error`

Scheduler summary 会按错误码聚合，持久化错误文本带稳定错误码前缀，且不包含 Token 或请求正文。

### P1-6 Session 失效与重连状态

状态：待完成。需要统一 Telegram Session 失效错误码，并确保账号进入明确的重连状态，避免无效 Session 持续触发任务。

## P2：维护性优化

### P2-1 Repository 文件体积过大

不建议立即重写。应在测试覆盖充分后，按领域逐步拆分内部模块，同时保持现有 `createD1Repository()` 对外接口不变。

### P2-2 生产配置基线

基础部分已由 `/ready` 覆盖。后续可增加部署后 smoke check，但不得打印 Secret。

### P2-3 CI 关键边界

当前仍需补充：

1. 用户 A 不能读取用户 B 的账号、任务和运行。
2. 同一 dedupe key 只能创建一个 scheduled run。
3. 同一账号一次只能 dispatch 一个 run。
4. stale dispatch 可恢复，但不会重复创建 run。
5. ambiguous run 不会被自动重试。
6. Session 失效后账号进入明确的重连状态。
7. 所有 API 错误响应经过脱敏。

## 剩余实施顺序

1. Session 失效错误分类和账号重连状态。
2. 跨用户隔离自动化测试。
3. ambiguous 不重试、stale dispatch 与 dedupe 边界测试。
4. 完整 CI 验证。
5. PR 从 Draft 转为 Ready 后统一合并。

## 当前不建议进行的改动

- 不迁移到新的框架或运行平台。
- 不替换 Cloudflare Worker、D1 或 GitHub Actions。
- 不重写整个 Repository。
- 不新增与当前 Telegram 自动消息/签到无关的业务。
- 不在状态机和幂等测试完成前扩大自动重试范围。

## 验收标准

- 所有 API 错误都有可关联的 `request_id`。
- 健康检查能区分“存活”和“可工作”。
- 状态名称有单一来源。
- Scheduler 自动恢复有结构化、脱敏指标。
- GitHub dispatch 失败有稳定错误码。
- Session 失效不会造成持续失败或重复执行。
- 关键安全边界被自动化测试覆盖。
