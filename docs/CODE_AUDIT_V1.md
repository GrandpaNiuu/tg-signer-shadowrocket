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

### P0-2 不得对不确定发送结果自动重试

Runner 超时、连接中断或 Telegram 返回结果无法确认时必须保持 `ambiguous`，不能转换为普通失败后自动重试。

风险：重复签到、重复命令或重复消息。

验证要求：增加超时后状态断言和后续 Scheduler 不重派发测试。

### P0-3 workflow input 只能包含不敏感 ID

`task-runner.yml` 和 `telegram-login.yml` 的输入必须继续只传 `run_id`、`flow_id` 等非敏感标识。Session、API Hash、验证码、2FA、代理凭据不得进入 workflow input 或命令行。

## P1：下一批应修复的问题

### P1-1 API 错误响应的 request_id 不完全一致

Worker 顶层异常和普通 404 会返回 `request_id`，但 `methodNotAllowed()` 当前只返回 `error`，未携带 `request_id`。

影响：前端或日志系统无法用同一请求标识关联 405 错误。

建议：将 `requestId` 传入 `methodNotAllowed()`，并增加 Worker 测试，确保 4xx/5xx 均包含 `request_id`。

### P1-2 `/health` 仅表示 Worker 进程可响应

当前 `/health` 固定返回 `ok: true`，没有检查 D1 binding、Repository 查询或关键配置。

影响：Worker 能返回 200，但数据库未绑定、migration 未完成或关键配置缺失时，外部仍会误判为健康。

建议拆分：

- `/health`：存活检查，仅证明 Worker 可响应。
- `/ready`：就绪检查，验证 D1 可执行轻量查询，并检查关键非敏感配置是否存在。

`/ready` 不得返回 Secret、数据库 ID、Token 或内部异常正文。

### P1-3 状态定义仍分散在 SQL、Worker 与 Runner 中

登录状态已有 `login-states.js` 集中定义，但账号状态、任务运行状态和 dispatch 状态仍大量以字符串形式分散在 SQL 和业务逻辑中。

影响：新增状态或修改状态时容易出现前端、Worker、D1 和 Runner 不一致。

建议新增集中状态模块并逐步迁移；第一阶段只集中常量与校验，不修改数据库枚举和值。

### P1-4 Scheduler reconciliation 缺少可观测结果

Scheduler 会调用 `reconcileRuns()`，但当前调度摘要没有记录 reconciliation 修复了多少 stale dispatch、过期 claim 或异常运行。

影响：系统自动恢复发生时，管理员无法判断恢复了什么，也无法发现持续性故障。

建议让 `reconcileRuns()` 返回结构化计数，并写入 scheduler 脱敏日志。

### P1-5 调度失败原因需要稳定错误码

当前 GitHub dispatch 非 2xx 时主要保存文本，例如 `GitHub workflow dispatch returned HTTP ...`。

影响：后台只能按文本展示，难以聚合、筛选和告警。

建议同时记录稳定错误码，例如 `github_dispatch_http_error`、`github_dispatch_network_error`、`github_dispatch_timeout`。

## P2：维护性优化

### P2-1 Repository 文件体积过大

`worker/src/repository.js` 同时承担认证、用户、Session、Secret、账号、任务、运行、登录流程和调度持久化。

不建议立即重写。应在测试覆盖充分后，按领域逐步拆分内部模块，同时保持现有 `createD1Repository()` 对外接口不变。

### P2-2 生产配置基线需要自动验证

建议新增只检查非敏感配置的部署验证，确认 DB binding、GitHub owner/repo/workflow 文件名、Runner OIDC audience、Admin origin 与 Scheduler lead seconds。

Secret 只检查“是否配置”，不得打印值。

### P2-3 CI 应明确覆盖关键边界

需要补充以下最小集成场景：

1. 用户 A 不能读取用户 B 的账号、任务和运行。
2. 同一 dedupe key 只能创建一个 scheduled run。
3. 同一账号一次只能 dispatch 一个 run。
4. stale dispatch 可恢复，但不会重复创建 run。
5. ambiguous run 不会被自动重试。
6. Session 失效后账号进入明确的重连状态。
7. 所有 API 错误响应经过脱敏。

## 推荐实施顺序

### PR #3：统一 API 错误追踪

让 404、405、认证失败、校验失败和 500 都返回 `request_id`，并增加 Worker 测试。风险低，不改数据库、调度或 Runner。

### PR #4：增加 `/ready`

保留现有 `/health` 行为，新增 D1 与非敏感配置就绪检查。风险低。

### PR #5：集中运行状态常量

新增状态常量和合法状态校验，先替换 Worker 内硬编码字符串，不修改数据库中的现有状态值。风险中低。

### PR #6：Scheduler reconciliation metrics

Repository 返回结构化恢复计数，Scheduler 输出脱敏指标，并增加 stale dispatch 和 expired claim 测试。风险中。

### PR #7：Session 失效与重连状态

统一 Telegram Session 失效错误码，明确账号何时进入 `reconnect_required`，防止无效 Session 持续触发失败任务。风险中高。

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
- Session 失效不会造成持续失败或重复执行。
- 关键安全边界被自动化测试覆盖。
