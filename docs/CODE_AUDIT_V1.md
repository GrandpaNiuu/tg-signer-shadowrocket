# Code Audit Report v1

审计范围：`main` 基线以及 PR #4 `feat/audit-remediation-v1` 中的 Cloudflare Pages 后台、Cloudflare Worker、D1 Repository、Scheduler、GitHub Actions 入口与 Python Runner 运行边界。

本报告只针对当前仓库，不扩展到其他业务或项目。

## 结论

当前架构主链路明确：Pages → Worker → D1 → GitHub Actions → Runner → Telegram。现阶段不建议迁移架构；本轮整改集中处理状态一致性、可观测性、用户隔离、幂等和故障恢复。

仓库已经具备以下基础：

- D1 是唯一调度和配置来源。
- Scheduler 使用 dedupe key 防止同一计划时间重复创建运行。
- 同一 Telegram 账号通过 dispatch reservation 保持串行。
- 不确定发送结果使用 `ambiguous`，不会盲目重试。
- workflow input 仅传递不敏感的 `run_id` 或 `flow_id`。
- Worker 使用统一错误响应、请求标识和脱敏日志。

## P0：必须保持的安全与执行边界

### P0-1 不得削弱用户数据隔离

所有后台资源访问必须继续通过 `repository.forUser(identity)` 进入用户作用域。任何新增 Repository 方法都必须明确检查 `user_id`，管理员和 OIDC Runner 接口除外。

风险：跨用户读取或修改账号、任务、运行记录与 Secret。

状态：已完成自动化验证。

- 账号、任务和运行读取测试验证 SQL 同时绑定资源 ID 与当前 `user_id`。
- 后台账号路由验证只调用 scoped Repository。
- 手动执行其他工作区任务返回 404，不进入 enqueue/dispatch。

### P0-2 不得对不确定发送结果自动重试

Runner 超时、连接中断或 Telegram 返回结果无法确认时必须保持 `ambiguous`，不能转换为普通失败后自动重试。

风险：重复签到、重复命令或重复消息。

状态：已完成自动化验证。

- Python Engine 仅在 `retryable && !ambiguous` 时重试。
- Timeout 和传输不确定错误只执行一次并返回 `ambiguous`。
- Scheduler 只选择 `queued/pending`，不会选择 `ambiguous`。
- Reconciliation 只将过期 `claimed/running` 转为 `ambiguous`，不会再次派发。

### P0-3 workflow input 只能包含不敏感 ID

`task-runner.yml` 和 `telegram-login.yml` 的输入必须继续只传 `run_id`、`flow_id` 等不敏感标识。Session、API Hash、验证码、2FA、代理凭据不得进入 workflow input 或命令行。

状态：已核查。当前 workflow input 仅传不敏感 ID；Session 继续通过 OIDC 领取后经 stdin 交给隔离子进程。

## P1：整改进度

### P1-1 API 错误响应 request_id

状态：已完成。

- 所有 Worker 响应带 `x-request-id`。
- JSON 错误响应会补齐顶层 `request_id`。
- 已覆盖 404、405 与 Cloudflare `cf-ray` 透传。

### P1-2 `/health` 与 `/ready`

状态：已完成基础生产就绪检查。

- `/health` 仅表示 Worker 可以响应。
- `/ready` 检查关键配置、GitHub Token 是否已配置、`SECRET_ROOT_KEY` 是否为有效的 32 字节 Base64，以及 D1 是否包含 `accounts/tasks/task_runs/secret_values` 核心表。
- 数据库异常和 Secret 内容不会返回给调用方。

说明：`/ready` 不向 GitHub 发外部探测请求。Token 权限、workflow 是否启用和生产域名连通性应由部署后的 smoke check 验证。

### P1-3 状态定义集中化

状态：核心状态契约已完成。

- 账号状态统一为 `disconnected/login_pending/connected/reconnect_required/error`。
- 运行状态和 dispatch 状态由共享模块定义并校验。
- Admin 已识别 `reconnect_required`；`needs_reauth` 仅作为早期版本兼容显示。
- SQL 中的状态字符串暂时保留，以避免在没有完整 D1 集成测试前进行大范围机械替换。

### P1-4 Scheduler reconciliation 可观测性

状态：已完成。

Scheduler summary 与 Cron 脱敏结构化日志会在非零时输出：

- `cancelled_unavailable`
- `reset_dispatches`
- `expired_runs`
- `expired_queued`

测试同时验证 stale dispatch 只恢复排队任务，过期执行转为 `ambiguous`。

### P1-5 调度失败稳定错误码

状态：已完成。

GitHub dispatch 失败和异常分为：

- `github_dispatch_http_error`
- `github_dispatch_network_error`
- `github_dispatch_timeout`
- `github_dispatch_config_error`
- `github_dispatch_state_update_failed`（GitHub 已接受但 D1 状态写入异常，作为 warning）

稳定错误码会写入 D1 `error_code`，Scheduler summary 按 code 聚合。GitHub 已接受 workflow 后，D1 状态写入异常不会把任务重置成 pending，避免重复派发。

### P1-6 Session 失效与重连状态

状态：已完成。

- Runner 将 Telegram 授权失效统一返回 `session_invalid`。
- Runner 完成回调会将对应账号更新为 `reconnect_required`。
- 幂等 finalizer 重试仍会补齐缺失的账号状态转换。
- 账号不再满足 `connected` 条件，因此同账号下一任务不会继续派发；后续 reconciliation 会取消不可执行的 queued runs。
- Admin 显示“需要重新登录”。

## P2：维护性优化

### P2-1 Repository 文件体积过大

状态：保留为后续独立 PR。

不建议在本轮重写。应在 D1 行为测试更完整后，按认证、账号、任务、运行、登录和 Secret 领域逐步拆分，同时保持 `createD1Repository()` 对外接口兼容。

### P2-2 生产配置基线

状态：基础部分由 `/ready` 覆盖。

后续部署流程应增加不打印 Secret 的 smoke check，验证：

- `/ready` 返回 200；
- GitHub workflow 文件和 ref 可访问；
- Token 具有 Actions write；
- Pages Service Binding 指向正确 Worker。

### P2-3 CI 关键边界

当前自动化测试已经覆盖：

1. 用户 A 无法读取或手动执行用户 B 的资源。
2. 同一 task occurrence 使用稳定 dedupe key，重复 enqueue 不再次 dispatch。
3. 同一 Telegram 账号存在 active run 时不能再 reserve dispatch。
4. stale dispatch 只恢复 queued 状态，并继续受 dedupe 约束。
5. ambiguous run 不重试、不重新派发。
6. Session 失效后账号进入 `reconnect_required`。
7. 调度错误和日志使用稳定 code、长度限制与脱敏文本。

## 本轮 PR 合并前检查

1. 完整 Runner、Worker、Admin CI 全绿。
2. PR 保持 Draft，直到最后一次 diff review 完成。
3. 确认没有 D1 migration；本轮使用现有状态字符串和列。
4. 部署到测试环境后检查 `/ready`、一次普通消息、一次失败任务和一次 Session 验证。
5. 确认 Cron 日志中的 reconciliation、failures_by_code 和 warnings_by_code 不包含 Secret。

## 后续独立 PR

以下问题不继续扩大 PR #4 的范围：

- 新环境部署流程与旧 D1 takeover audit 的分流。
- PBKDF2 迭代次数从 100000 向文档目标值升级及登录后渐进 rehash。
- `repository.js` 按领域拆分。
- 部署后 GitHub/Cloudflare smoke check。

## 当前不建议进行的改动

- 不迁移到新的框架或运行平台。
- 不替换 Cloudflare Worker、D1 或 GitHub Actions。
- 不重写整个 Repository。
- 不新增与 Telegram 自动消息/签到无关的业务。
- 不扩大对 `ambiguous` 结果的自动重试。

## 验收标准

- 所有 API 错误都有可关联的 `request_id`。
- 健康检查能区分“存活”和“具备核心运行条件”。
- 前后端账号状态契约一致。
- Scheduler 自动恢复有结构化、脱敏指标。
- GitHub dispatch 失败有稳定错误码并正确持久化。
- Session 失效不会造成持续失败或立即派发下一任务。
- 关键用户隔离、幂等、串行与 ambiguous 边界有自动化测试。
