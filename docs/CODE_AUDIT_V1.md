# Code Audit Report v1

审计范围：Cloudflare Pages 后台、Cloudflare Worker、D1 Repository、Scheduler、GitHub Actions 入口与 Python Runner 的运行边界。

本报告只针对当前仓库，不扩展到其他业务或项目。

## 结论

当前架构主链路明确：Pages → Worker → D1 → GitHub Actions → Runner → Telegram。现阶段不建议更换架构，维护重点是状态一致性、用户隔离、部署恢复、可观测性和故障边界。

仓库当前具备：

- D1 作为唯一调度和配置来源；
- Scheduler dedupe key 与账号级串行 reservation；
- `ambiguous` 结果不盲目重试；
- 集中状态定义与 Session 失效重连状态；
- Worker request id、`/health`、schema-aware `/ready`；
- GitHub dispatch 稳定错误码、超时与恢复指标；
- 跨用户隔离、幂等、stale dispatch 和 Session 边界测试；
- Worker 部署 bootstrap/fresh/legacy 模式及部署后 smoke check；
- 密码哈希参数边界和成功登录后的渐进 rehash。

## 已完成的 P0 安全与执行边界

### 用户数据隔离

所有后台资源访问继续通过 `repository.forUser(identity)` 进入用户作用域。自动化测试覆盖账号、任务、运行记录与跨用户手动执行拒绝。

### 不确定发送结果

Runner 超时、连接中断或 Telegram 返回结果无法确认时保持 `ambiguous`。测试确认该状态不会自动重试或重新派发。

### Workflow 输入

`task-runner.yml` 和 `telegram-login.yml` 只接收不敏感的 `run_id` 或 `flow_id`。Session、API Hash、验证码、2FA 和代理凭据不进入 workflow input 或命令行。

## 已完成的 P1 整改

### Request ID

所有 Worker 响应带 `x-request-id`，错误 JSON 带顶层 `request_id`。外部 `cf-ray` 仅在字符和长度合法时使用，否则回退到随机 UUID。

### Liveness 与 readiness

- `/health` 只表示 Worker 可响应；
- `/ready` 检查核心 D1 表、必需配置、GitHub Token 是否配置及 `SECRET_ROOT_KEY` 格式；
- 诊断不返回数据库异常正文、Token 或 Secret。

### 状态与 Session

账号状态统一为：

- `disconnected`
- `login_pending`
- `connected`
- `reconnect_required`
- `error`

只有 `failed + session_invalid` 的 Runner 结果会触发 `reconnect_required`。幂等 finalizer 可修复遗漏转换，矛盾结果和其他 GitHub Run 无法修改账号状态。

### Scheduler 与 dispatch

Cron 结构化日志输出 reconciliation 指标：

- `cancelled_unavailable`
- `reset_dispatches`
- `expired_runs`
- `expired_queued`

GitHub dispatch 使用有界超时，并区分 HTTP、网络、超时、配置和状态写入错误。稳定错误码与重试时间通过一次 D1 更新写入。GitHub 已接受 workflow 后，本地状态写入异常不会把 run 重置为 pending。

### 部署恢复

Worker 部署明确分为：

- `bootstrap`：首次创建服务，要求 `/health`；
- `fresh_install`：空库或普通升级，要求 `/health` 与 `/ready`；
- `legacy_takeover`：在 migration 后验证迁移证据，再部署并检查 `/health` 与 `/ready`。

部署 workflow 在业务表查询前应用 migration。旧接管审计只输出计数，不输出用户数据或 Secret。部署模式顺序由静态契约测试保护。

### 密码存储维护

邮箱密码继续使用 PBKDF2-HMAC-SHA256、随机盐和部署 pepper。当前免费 Worker 部署保持 100000 次兼容基线，配置范围为 100000–1000000。

已增加：

- 存储迭代次数上限，防止异常记录造成超高 CPU 消耗；
- 损坏 Base64、异常盐和哈希长度安全返回无效凭据；
- 目标迭代数提高后，active 用户在下一次成功登录时使用新盐渐进 rehash；
- D1 乐观条件更新，防止覆盖并发密码修改；
- rehash 暂时失败不阻断已验证的登录。

## 当前剩余维护项

### P1：实际环境验证

- 确认最新 `main` 的 Quality Checks 全绿；
- 确认 Worker 自动部署 smoke check 通过；
- 查看生产 Cron 结构化日志，确认不包含 Secret；
- 在实际 Worker 环境测量密码登录 CPU，再决定是否提高 `PASSWORD_HASH_ITERATIONS`。

### P2：Repository 渐进拆分

`worker/src/repository.js` 仍承担认证、账号、任务、运行、调度、登录流程、设置和通知等多个领域。不要一次性重写。继续采用小型适配模块和领域测试逐步迁移，同时保持：

- `createD1Repository()` 对外接口稳定；
- Admin user-scoped 与 Runner global 方法边界明确；
- 不修改已部署历史 migration；
- 每次拆分均有隔离、幂等和状态机回归测试。

### P2：前端与生产可观测性

- 为部署结果和最近 Cron 异常增加更直观的后台只读状态；
- 对 `github_dispatch_state_update_failed` 等 warning 建立告警或后台筛选；
- 继续检查 401、403、422、500、204 和 OAuth redirect 的 request-id 契约。

## 当前不建议进行的改动

- 不迁移到新的框架或运行平台；
- 不替换 Cloudflare Worker、D1 或 GitHub Actions；
- 不一次性重写整个 Repository；
- 不扩大 `ambiguous` 的自动重试范围；
- 不在免费 Worker 上未经 CPU 基准直接提高密码 KDF 成本；
- 不新增与 Telegram 自动消息和签到无关的业务。

## 当前验收标准

- API 错误可通过 request id 关联；
- 健康检查区分存活与可工作；
- 用户状态和运行状态具有明确契约；
- Scheduler 恢复有结构化脱敏指标；
- Dispatch 失败有稳定错误码；
- Session 失效停止后续任务并提示重连；
- 全新部署不会被旧接管审计阻塞；
- 普通部署完成后自动验证 `/health` 与 `/ready`；
- 密码配置提高时无需强制用户重置密码；
- 关键安全边界由自动化测试覆盖。
