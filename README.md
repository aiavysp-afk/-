# 中原到家

最新安全增量：[安全通知 Outbox](docs/SAFETY_NOTIFICATION_IMPLEMENTATION.md)已增加阿里云 `QuerySendDetails` 只读送达查询、独立回执门禁、48 次有限退避、送达/失败/未知状态和后台积压/死信摘要；第 20 批迁移及服务器私有验收通过。自动发送、回执查询和真人主备演练均保持关闭，代码验收不等于真实短信送达或经营上线。

最新安全开发：[安全事件主备值班闭环](docs/SAFETY_DUTY_IMPLEMENTATION.md)与[安全通知 Outbox](docs/SAFETY_NOTIFICATION_IMPLEMENTATION.md)已完成值班表、唯一未关闭事件、主岗确认、超时备岗升级、确认人关闭，以及短信通知的数据库租约、并发单领、退避、死信、人工复核和后台可观测性；真实 PostgreSQL 专项验证通过。真实自动发送和真人主备短信演练仍未完成，`SAFETY_NOTIFICATION_DISPATCH_ENABLED` 与 `SAFETY_DUTY_CONFIRMED` 均保持 `false`，不能据此公开经营。

最新小程序验收准备：[修复订单/服务页WXML编译错误并生成独立联系渠道验收包](docs/MINIAPP_WECHAT_ACCEPTANCE.md)。官方本机编译器8页通过，开发者工具首页恢复渲染；专项包不含联网/登录/交易，不等于商城正式版或真机接通验收。

最新开发：[短信/地图受限适配器、企业微信客服与商家紧急值班拨号](docs/SUPPORT_CHANNELS_IMPLEMENTATION.md)。代码`6411b16`已通过CI并部署私有验收；找回旧客服链接并按用户归属/账号/绑定确认开放私有入口，独立确认门禁默认关闭。仍缺完整SMS/地图凭据和真人微信/接通/安全值班验收；公网继续维护，真实资金与收费渠道关闭，不等于正式上线。

最新部署状态：用户明确授权后，mtsc.top 两套旧商城在线数据和过期版本已清理，公网处于 503 维护模式。新版独立生产库 16 批迁移完成，但真实经营门禁未通过，仍未上线。[清理实录、改动清单与后续检查](docs/LEGACY_RETIREMENT_20261004.md)。

最新增量：[验证器丢失受审恢复](docs/MFA_RECOVERY_IMPLEMENTATION.md)；本人必须用五分钟内的新微信小程序会话发起，另一名同组织、已完成MFA的管理员复核，批准后旧验证器和本人全部会话原子撤销。本地、CI和独立私有服务器验收已完成；真人微信/验证器验收和正式经营门禁未通过前不公开经营。

面向正规上门按摩 SPA、足部舒缓与养生放松的三端预约平台。当前仓库包含：

- `apps/miniapp`：微信原生小程序用户端
- `apps/workbench-h5`：技师移动工作台
- `apps/admin-web`：PC 运营管理后台
- `apps/api`：NestJS 模块化 API
- `packages/contracts`：跨端共享类型与校验

## 本地启动

1. 复制 `.env.example` 为 `.env`。
2. 启动基础设施：`docker compose -f infra/docker-compose.dev.yml up -d`。
3. 安装依赖：`pnpm install`。安装完成时会按 `apps/api/prisma/schema.prisma` 自动生成 Prisma Client；需要单独重建时运行 `pnpm --filter @zydj/api prisma:generate`。
4. 初始化数据库：`pnpm --filter @zydj/api prisma:migrate`。
5. 启动三端 Web 与 API：`pnpm dev`。

默认地址：API `http://localhost:3100/v1`，管理后台 `http://localhost:5173`，技师工作台 `http://localhost:5174`。

微信支付、短信、地图和 SOS 值班链路默认是明确标识的开发模式。生产环境存在 mock 集成、空安全热线或缺失密钥时，API 会拒绝启动。

小程序“我的”页已接入 M1 登录入口。本地 `AUTH_PROVIDER=mock` 只用于开发，生产会强制要求微信 AppSecret、会话 pepper 和 32 字节数据加密密钥；真实值只通过服务器环境变量注入。

管理后台现已接入经营看板、订单调度、技师管理、排班中心、服务项目、退款复核、服务区域、安全值班、账户安全、权限审计和系统上线门禁等真实本地 API；当前页面搜索会筛选所在模块的数据。调度与排班写入都会执行组织权限、有效技师、排班和冲突校验，并记录审计证据；后台不返回服务地址或客户电话。执行开发种子时只有显式设置 `SEED_DEVELOPMENT_IDENTITIES=true` 才会创建本地运营、调度和技师演示身份及次日班次；这些身份和登录按钮不会作为生产管理员认证方案。

## 当前阶段

2026-10-04已完成[后台MFA基础](docs/STAFF_MFA_IMPLEMENTATION.md)、[微信后台安全登录交接](docs/BROWSER_LOGIN_IMPLEMENTATION.md)与[验证器丢失受审恢复](docs/MFA_RECOVERY_IMPLEMENTATION.md)。这些是代码与隔离环境验收，不表示真人设备、真实微信主体或公开生产环境已验收。

已完成工程基线、品牌视觉、公开配置、M1 微信登录/会话/RBAC、M2 实时目录/排班/占位/报价/订单及Mock支付，以及退款持久化、申请/独立复核、累计额度占用、并发幂等、结果回调/原单查询/恢复租约、一次记账与退款管理页面。小程序目录、预约、订单和退款申请已接入API。微信JSAPI预下单已加入持久化单次派发、响应验签、RSA调起参数和小程序SDK入口；原单自动查询/幂等关单/再次核实、恢复租约和人工升级已实现，见[补偿交付](docs/WECHAT_RECOVERY_IMPLEMENTATION.md)。三个开关均默认false。经营看板已改为登录后读取所属组织的真实数据库汇总；订单调度已接入真实订单、排班校验、冲突防护和并发幂等指派；技师H5的“今日、订单、排班、我的”四个导航页均已启用，读取本人今日订单、本周详细班次及本月已完成订单流水，并支持本人今日订单按状态机执行出发、到达、开始服务和提交客户确认；小程序客户可在待确认状态二次确认后完成订单。履约和客户确认操作均带行锁、归属校验、状态机、事件、审计与并发幂等保护。技师本月流水只展示真实订单总额；因平台抽成、结算和打款规则尚未配置，可结算金额明确显示“待核算”，不会伪造收入。正式H5登录与正式结算仍未完成。真机资金、正式后台认证/MFA和运维值班未验收，不能直接宣称生产资金闭环验收。

交付入口：[环境变量](docs/ENV_VARIABLES.md)、[数据库角色初始化](infra/database-init.sql)、[数据库迁移脚本](scripts/database-init.ps1)、[完整部署与人工检查项](docs/DEPLOYMENT.md)、[退款设计](docs/REFUND_IMPLEMENTATION.md)、[全流程自测结果](docs/SELF_TEST_REPORT.md)、[改动文件清单](docs/CHANGE_FILES.md)。

2026-10-04已部署服务器独立私有验收环境，完整迁移/备份恢复/流程验证及GitHub CI成功，原商城不变。实际版本、私有访问方式和容量警告见[验收记录](docs/DEPLOYMENT_ACCEPTANCE_20261004.md)。真实资金开关仍false，不能作为公网经营版。

全流程HTTP与小程序运行逻辑自测：在独立本地 `zhongyuan_daojia_test` 执行migration并设置 `MALL_TEST_DATABASE_URL`，先 `pnpm build` 再 `pnpm --filter @zydj/api test:mall`。脚本拒绝生产/远程目标，创建并清理自己的合成记录。GitHub Actions已加入相同验证步骤。

本地数据库支付验证可运行 `pnpm --filter @zydj/api exec tsx scripts/verify-wechat-payments.ts`，需显式设置 `PAYMENT_DB_TEST_URL` 指向本机 `zhongyuan_daojia` 开发库；程序创建自己的临时组织并在结束后清理。微信支付接入说明见 [支付通知与对账](docs/WECHAT_PAY_IMPLEMENTATION.md)。
