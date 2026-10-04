# 安全事件主备值班闭环

更新日期：2026-10-05

## 本轮交付

- 每个组织同一时刻只能有一份活动值班表，主岗和备岗必须是两个不同、状态有效的 `SAFETY_DUTY` 成员；配置操作仅允许组织 `ADMIN`，旧配置会在同一事务中停用。
- 客户只能针对自己的履约中订单发起固定分类的安全事件。请求必须携带幂等键；同键同请求返回原事件，同键不同请求拒绝。
- 事件创建时快照主岗、备岗、确认截止时间，防止事后换班改变既有事件责任人。
- 截止前仅主岗可确认；超过截止时间后，接口或后台扫描会在数据库行锁内只升级一次，之后仅备岗可确认。
- 事件只能由实际确认人使用固定结论码关闭。创建、升级、确认和关闭均写状态事件、审计日志及 Outbox。
- 客户创建/列表响应不会暴露主岗或备岗的内部用户 ID；责任快照只在数据库和已授权工作人员视图中保留。
- 数据库同时约束主备分离、60–900 秒确认期限、组织唯一活动值班表和“报告人 + 幂等键”唯一性，不能只依赖前端或单进程判断。

## API

- `POST /v1/admin/organizations/:organizationId/safety-duty-rosters`
- `GET /v1/admin/organizations/:organizationId/safety-duty-rosters/current`
- `POST /v1/orders/:orderId/safety-incidents`
- `GET /v1/orders/:orderId/safety-incidents`
- `GET /v1/admin/organizations/:organizationId/safety-incidents`
- `POST /v1/admin/organizations/:organizationId/safety-incidents/:id/acknowledge`
- `POST /v1/admin/organizations/:organizationId/safety-incidents/:id/close`

完整请求结构、分类和结论码见 [OpenAPI](openapi.v1.yaml)。

## 并发与失败语义

1. 创建事件先锁定订单并重新校验订单本人、组织和履约状态；值班配置也在组织锁内重新校验主备身份。
2. 并发相同请求依靠唯一索引和请求指纹只保留一条事件、一次 OPENED 事件和一次 Outbox。
3. 超时扫描每 30 秒运行，多个实例即使同时看到到期记录，也会通过事件行锁和状态条件只升级一次。
4. 重复确认只对同一确认人幂等；不同人员不能接管已确认事件。关闭同样只允许原确认人。
5. Outbox 当前仅是可靠持久化边界，尚无短信、电话或企业微信自动投递消费者。API 成功不等于真人已接通，也不能替代公共应急服务。

## 验证

独立本地 PostgreSQL 17.6 数据库已实际执行全部 17 批迁移，并运行：

```powershell
$env:SAFETY_TEST_DATABASE_URL='postgresql://zhongyuan:local_only@127.0.0.1:5432/zhongyuan_safety_test?schema=public'
pnpm --filter @zydj/api test:safety
```

验证覆盖数据库主备约束、并发事件幂等、截止前主岗限制、并发单次升级、升级后备岗限制、并发重复确认、仅确认人关闭、审计及 Outbox。脚本拒绝非本机专用库；CI 仅允许 Actions 自身的隔离测试库，并在结束时清理合成数据。

## 上线门禁

- 至少两名不同自然人完成主岗/备岗排班、独立设备登录与交接。
- Outbox 消费者、送达重试、人工告警面板和积压监控完成；不得把数据库事件写入等同于通知送达。
- 演练主岗超时、备岗接手、真人确认、公共应急转介、失败回退和事后审计。
- `SAFETY_DUTY_CONFIRMED` 继续保持 `false`，直到上述真人和运维闭环验收签字。该变量不是本轮代码的绕过开关。
- 生产应用第 17 批迁移前必须备份并在副本执行；回滚应用时保留新表和所有安全事件，不得删除或手工改状态。
