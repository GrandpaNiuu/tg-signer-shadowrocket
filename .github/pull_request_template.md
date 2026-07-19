## 变更目的

<!-- 说明要解决的问题，不要只描述修改了哪些文件。 -->

## 主要修改

- 

## 影响范围

- [ ] `admin/` Pages 后台
- [ ] `worker/` API、调度、安全或 D1
- [ ] `runner/` Telegram 执行端
- [ ] `.github/workflows/`
- [ ] D1 migration
- [ ] 文档或工程配置

## 安全检查

- [ ] 未提交 Session、API Hash、验证码、2FA、Token、密码或生产数据
- [ ] 用户数据访问仍受 owner/tenant 边界约束
- [ ] workflow input 仅包含不敏感 ID
- [ ] 新增日志和错误信息已脱敏
- [ ] 不确定发送结果不会被自动重试
- [ ] 未扩大 Skill allowlist 之外的代码执行能力

## 数据库与部署

- Migration：无 / 有（请说明）
- 新增或修改的变量/Secret：无 / 有（请说明）
- 部署顺序：
- 回滚方式：

## 测试

- [ ] `python -m unittest discover -s runner/tests -p 'test_*.py' -v`
- [ ] `npm test --prefix worker`
- [ ] `npm test --prefix admin`
- [ ] 已完成必要的手动端到端验证

测试结果或未执行原因：

## 运行风险

<!-- 说明是否可能影响登录、Session、调度、重复发送、账号状态或已有任务。 -->
