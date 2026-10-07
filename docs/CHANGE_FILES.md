# 本次改动文件清单

小程序导航与功能键收口（2026-10-06）：将原生底栏升级为中原到家统一的五栏自定义导航，保留“首页、服务、技师、订单、我的”固定信息架构，增加大触控区、选中态渐变胶囊、底部安全区适配和各主页面选中态同步。新增自动扫描，验证所有 WXML `bindtap`/`bindchange`/`bindinput` 均存在页面处理函数，所有 `navigator` 目标均已注册，`switchTab` 只指向五个主导航页；支付、求助、客服、功能键和路由专项共 49 项通过。微信开发者工具真实预览与上传成功，AppID `wxab76ea213eb6d01a` 的候选开发版本更新为 `7.0.1`，上传包 77,946 字节；尚未提交审核或发布，不改变公网 503 及真实资金、短信、地图和值班门禁。

小程序发布包收口（2026-10-05）：主页改为读取正式服务目录与公开配置，客服入口使用已验收企业微信链接，郑州全域服务范围明确展示；移除“开发预览”、虚构技师姓名/评分/服务次数和无处理函数的地址、优惠券、发票等菜单。技师页改为资料审核、真实排班和服务边界说明；“我的”页订单统计改由当前登录用户真实订单计算；预约和订单页补齐客服导航；开发者工具恢复合法域名校验。微信开发者工具真实预览编译成功；覆盖现网 `6.0.14` 的候选开发版本 `7.0.0` 已上传至 AppID `wxab76ea213eb6d01a`，上传包 75,168 字节，尚未提交审核或发布。生产 API 仍受 fail-closed 门禁保护，未绕过短信、地图和值班确认要求。

高德地图迁移（2026-10-07）：地图实现统一切换为高德和 GCJ-02；小程序增加定位、中文地址逆解析及 POI 联想，订单持久化经纬度；技师端增加位置上报、驾车距离/预计时长与高德导航，用户订单页仅在履约阶段查看技师位置状态。真实 Key 仅存在忽略的本地或服务器环境文件，仓库只记录变量名。新增第 23 批坐标与技师位置迁移、隔离验收脚本和接入说明；生产发布与真机定位/导航验收仍需单独完成。

该切片最终运行提交为 `78aaf4e80b4b504df44f3930c358a2c77e76b158`；同步修改 `scripts/package-contact-acceptance.test.mjs` 的公开配置夹具。CI 37300569286 成功并部署私有验收，第 21 批迁移、升级前备份、回环 HTTP/端口、零 warning、公网 503 和关闭门禁均已核验；上传归档在验收后删除，release 与数据库备份保留。

最新送达回执切片（2026-10-05）：新增 `apps/api/prisma/migrations/20261005153000_safety_delivery_receipts/migration.sql`、`apps/api/src/safety/safety-notification-receipt.worker.ts` 及测试、`apps/api/src/safety/safety-notification.service.test.ts`；修改 Prisma schema、阿里云短信客户端、投递工作者、环境门禁、共享合约、安全接口、后台安全页面、OpenAPI、私有/生产准备脚本与文档。实现只读回执查询、有限退避、数据库状态约束、积压/死信摘要和明确的 fail-closed 配置；未包含号码、短信正文或渠道密钥，未开启真实调用。

最新私有部署加固（2026-10-05）：`scripts/setup-private-acceptance.mjs` 为新建环境写入、为旧环境仅补齐缺失的非秘密安全门禁，并拒绝任何非 Mock 渠道或已开启的支付/短信/地图/安全通知门禁；没有覆盖已有配置值或读取/提交秘密。同步更新 `docs/DEPLOYMENT_ACCEPTANCE_20261004.md`、`docs/IMPLEMENTATION_STATUS.md`、`docs/SELF_TEST_REPORT.md` 与本清单，记录 `544b080`、CI、19 批迁移、备份、HTTP/端口和公网维护验证。

最新安全通知 Outbox 切片（2026-10-05）：新增第 19 批迁移、租约/退避/死信工作者、阿里云安全短信调度、加密值班号码管理、通知状态/人工复核接口和后台面板；补充 OpenAPI、环境变量、部署、自测与专项说明。核心新增文件：`apps/api/prisma/migrations/20261005090000_safety_notification_outbox/migration.sql`、`apps/api/src/safety/safety-notification.dispatcher.ts`、`apps/api/src/safety/safety-notification.worker.ts`、`apps/api/src/safety/safety-notification.service.ts`、对应单测、`apps/api/scripts/verify-safety-notifications.ts`、`docs/SAFETY_NOTIFICATION_IMPLEMENTATION.md`。修改 Prisma/合约/安全模块、管理端、CI、README 及相关文档。真实发送和经营门禁未开启，不包含手机号或渠道密钥。

最新安全值班界面闭环（2026-10-05）在前一安全事件后端上新增第18批“同一订单唯一未关闭事件”迁移、小程序固定分类/二次确认/幂等重试入口、管理后台主备岗配置及确认/关闭队列、管理员候选人员接口、隔离开发身份和专项脚本。隔离 PostgreSQL 迁移/并发测试及 Codex 内管理员、主岗、备岗真实页面验收通过；角色切换竞态已修复，非管理员不显示内部人员 ID。没有接入真实自动通知、修改服务器生产数据或启用 `SAFETY_DUTY_CONFIRMED`。

本增量主要文件：

- `.github/workflows/ci.yml`
- `README.md`
- `apps/admin-web/src/main.tsx`
- `apps/admin-web/src/safety.tsx`
- `apps/admin-web/src/styles.css`
- `apps/api/prisma/migrations/20261005050000_safety_single_active_incident/migration.sql`
- `apps/api/prisma/seed.ts`
- `apps/api/scripts/verify-mall-flow.ts`
- `apps/api/scripts/verify-safety-duty.ts`
- `apps/api/src/safety/safety.controller.ts`
- `apps/api/src/safety/safety.service.ts`
- `apps/api/src/safety/safety.service.test.ts`
- `apps/miniapp/pages/orders/index.ts`
- `apps/miniapp/pages/orders/index.js`
- `apps/miniapp/pages/orders/index.wxml`
- `apps/miniapp/pages/orders/index.wxss`
- `apps/miniapp/types/global.d.ts`
- `packages/contracts/src/index.ts`
- `scripts/verify-miniapp-safety.test.mjs`
- `scripts/verify-miniapp-payment.test.mjs`
- `docs/SAFETY_DUTY_IMPLEMENTATION.md`
- `docs/openapi.v1.yaml`
- `docs/DEPLOYMENT.md`
- `docs/IMPLEMENTATION_STATUS.md`
- `docs/SELF_TEST_REPORT.md`
- `docs/CHANGE_FILES.md`

最新安全值班闭环（2026-10-05）新增第17批迁移、`apps/api/src/safety/` 模块、真实 PostgreSQL 并发验证脚本及 CI 步骤；更新 Prisma、共享合约、AppModule、OpenAPI、权限/部署/环境/自测/状态文档与 README。实现组织唯一主备岗、客户订单事件、幂等、防重复升级、阶段责任人确认、仅确认人关闭、状态事件/审计/Outbox。没有连接真实短信、电话或企业微信通知，没有修改服务器生产配置或 `SAFETY_DUTY_CONFIRMED`，不解除公网经营/资金门禁。完整设计见 `docs/SAFETY_DUTY_IMPLEMENTATION.md`。

本轮主要文件：

- `.github/workflows/ci.yml`
- `README.md`
- `apps/api/package.json`
- `apps/api/prisma/schema.prisma`
- `apps/api/prisma/migrations/20261005034000_safety_duty_incidents/migration.sql`
- `apps/api/scripts/verify-safety-duty.ts`
- `apps/api/src/app.module.ts`
- `apps/api/src/safety/safety.controller.ts`
- `apps/api/src/safety/safety.controller.test.ts`
- `apps/api/src/safety/safety-escalation.worker.ts`
- `apps/api/src/safety/safety.module.ts`
- `apps/api/src/safety/safety.service.ts`
- `apps/api/src/safety/safety.service.test.ts`
- `packages/contracts/src/index.ts`
- `packages/contracts/src/index.test.ts`
- `docs/SAFETY_DUTY_IMPLEMENTATION.md`
- `docs/openapi.v1.yaml`
- `docs/AUTHORIZATION_MATRIX.md`
- `docs/DEPLOYMENT.md`
- `docs/ENV_VARIABLES.md`
- `docs/INTEGRATION_GATES.md`
- `docs/IMPLEMENTATION_STATUS.md`
- `docs/SELF_TEST_REPORT.md`
- `docs/CHANGE_FILES.md`

最新客服真人闭环回执（2026-10-05）仅更新 5 个文档：`MINIAPP_WECHAT_ACCEPTANCE.md`、`SELF_TEST_REPORT.md`、`IMPLEMENTATION_STATUS.md`、`SUPPORT_CHANNELS_IMPLEMENTATION.md` 和本清单。用户明确确认新预览客服已打开，并在发送测试消息后收到真人回复；企业绑定、真机入口、消息送达和真人接待闭环通过。没有代码、服务器、数据库、密钥或上线开关变更，未解除失败兜底、另一设备、完整值班或经营/资金门禁。

同日失败回退自检只更新 `MINIAPP_WECHAT_ACCEPTANCE.md`、`SELF_TEST_REPORT.md`、`IMPLEMENTATION_STATUS.md` 和本清单：真实 profile 页验证客服不可用/电话未配置均只显示安全求助提示，临时 mock 与数据已恢复，34 项相关回归通过。没有真实外呼、拨号、服务器或代码变更；另一设备和现场无法接通/值班演练仍待人工完成。

同日第二台真机回执更新 5 个文档：`MINIAPP_WECHAT_ACCEPTANCE.md`、`SELF_TEST_REPORT.md`、`IMPLEMENTATION_STATUS.md`、`SUPPORT_CHANNELS_IMPLEMENTATION.md` 和本清单。用户明确确认独立预览二维码在第二台真实设备通过；没有代码、服务器、数据库或上线开关变更。值班电话主备岗与真实无法接通升级演练仍待完成。

最新完整商城真机联系渠道修复（2026-10-05），共12个仓库文件：`apps/miniapp/app.ts`及生成JS、`pages/profile/index.ts`及生成JS、profile WXML、`scripts/verify-miniapp-wxml.test.mjs`，以及 `docs/MINIAPP_WECHAT_ACCEPTANCE.md`、`SELF_TEST_REPORT.md`、`IMPLEMENTATION_STATUS.md`、`SUPPORT_CHANNELS_IMPLEMENTATION.md`、`ENV_VARIABLES.md`、本清单。移除真机不可用的 localhost API，改为正式 HTTPS API；API 维护/断网时保留已确认的公开客服与电话，成功响应仍覆盖兜底。新增失败保持/成功覆盖/HTTPS基址测试及稳定 UI 选择器。53 项测试、6 项 typecheck/依赖任务、8 页官方 WXML 编译和开发者工具页面/真实点击自检通过。没有服务器、数据库、密钥、支付/SMS/地图开关变更，未上传、发消息或拨号。

同日预览回执仅更新本清单、`MINIAPP_WECHAT_ACCEPTANCE.md` 和 `SELF_TEST_REPORT.md`：用户确认开发者工具授权后，官方 `auto_preview` 成功推送 `pages/profile/index` 新预览，总包 63779 字节；没有正式上传、发送客服消息或拨号。

同日真机入口回执继续只更新上述 3 个文档：用户明确确认新预览“客服已打开”，入口项通过，原错误码 6 未复现；测试消息接收与真人回复仍待单独验收。

最新小程序侧微信客服绑定记录（2026-10-05），共5个文档文件：`docs/MINIAPP_WECHAT_ACCEPTANCE.md`、`SUPPORT_CHANNELS_IMPLEMENTATION.md`、`SELF_TEST_REPORT.md`、`IMPLEMENTATION_STATUS.md`、本清单。实时确认目标 AppID 后，记录微信公众平台原先无企业绑定、用户当场确认后企业 ID `ww715e0d876d9f3cb4` 与企业名称已显示，以及企业微信侧小程序/客服账号/当前代码链接的交叉核验。企业内存在两个同名账号，代码仍使用实时核验有效的第二个账号 `kfid/kfca6852bf5e57656af`，没有因第一个账号的不同链接误改代码。此次没有代码、数据库、环境变量、服务器、其他权限或资金配置变更，未上传小程序、通知手机、发消息或拨号；最近一次 iPhone 错误码 6 仍需真机验收关闭。

最新真实客服自检与模拟器提示修正（2026-10-04），共8个仓库文件：`apps/miniapp/utils/customer-service.ts`、生成 `customer-service.js`、`scripts/verify-customer-service.test.mjs`，以及 `docs/MINIAPP_WECHAT_ACCEPTANCE.md`、`SUPPORT_CHANNELS_IMPLEMENTATION.md`、`SELF_TEST_REPORT.md`、`IMPLEMENTATION_STATUS.md`、本清单。新增严格固定措辞 `DEVTOOLS_UNSUPPORTED_WORDING`，不映射 iPhone 错误码 6、不输出原文或重试；记录真实 SDK 自检、模拟器不支持的实证与小程序侧企业 ID 绑定未核验的缺口。本机另备份纠正了开发者工具纯端口索引以连接用户已允许的服务，此临时索引和备份不入仓库；无数据库、环境变量、服务器、密钥、资金或云端绑定修改，未发手机预览通知。上线前仍须先核验小程序侧绑定，再验证真实客服打开/真人响应与失败兜底，不能用模拟器通过替代。

最新同账号重新绑定记录（2026-10-04），共5个文档文件：`docs/MINIAPP_WECHAT_ACCEPTANCE.md`、`docs/SUPPORT_CHANNELS_IMPLEMENTATION.md`、`docs/SELF_TEST_REPORT.md`、`docs/IMPLEMENTATION_STATUS.md`、本清单。用户动作前明确确认后，企业微信后台已为“静享松弛桌游馆”重新选择并提交原账号“中原到家在线客服”，页面返回已接入列表；没有停止接入、取消授权、修改代码/服务器配置或解除任何上线门禁。操作后的 iPhone 微信实测仍待完成，不能据此把客服验收记为通过。

双后台只读核对记录（2026-10-04），共5个文档文件：`docs/MINIAPP_WECHAT_ACCEPTANCE.md`、`docs/SUPPORT_CHANNELS_IMPLEMENTATION.md`、`docs/SELF_TEST_REPORT.md`、`docs/IMPLEMENTATION_STATUS.md`、本清单。已确认“静享松弛桌游馆”就是目标 AppID，小程序接入的企业 ID、当前 kfid、客服账号、接待人员和时段均一致；真实 iPhone 入口仍失败。该次核对没有业务代码、迁移、服务器配置、消息发送或后台权限变更；截至该次核对，重新绑定同一客服账号尚待动作前确认，后续执行记录见上一段。

最新更正后复测记录（2026-10-04），共5个文档文件：`docs/MINIAPP_WECHAT_ACCEPTANCE.md`、`SUPPORT_CHANNELS_IMPLEMENTATION.md`、`SELF_TEST_REPORT.md`、`IMPLEMENTATION_STATUS.md`、本清单。20:05 iPhone 真机仍失败；已排除旧链接残留，并记录企业微信侧当前授权列表名称/客服账号及目标 AppID 尚待微信公众平台本人登录核对。没有业务代码、迁移、服务器配置或后台权限变更。

最新客服配置纠正记录（2026-10-04），共5个文档文件：`docs/MINIAPP_WECHAT_ACCEPTANCE.md`、`SUPPORT_CHANNELS_IMPLEMENTATION.md`、`SELF_TEST_REPORT.md`、`IMPLEMENTATION_STATUS.md`、本清单。企业微信后台只读核对确认当前客服链接与旧受控配置不一致；服务器两份配置已先备份后只纠正链接并保持权限，私有 API 公开配置复查通过。没有业务代码、迁移、密钥或数据库变更；仍须重新生成专项包并完成真机/真人验收，其他上线门禁不变。

最新客服诊断切片（2026-10-04），共12文件：`apps/miniapp/utils/customer-service.ts`、生成JS；`assets/contact-acceptance/pages/contact/index.js`、`index.wxml`、`index.wxss`；`scripts/verify-customer-service.test.mjs`、`package-contact-acceptance.test.mjs`；`docs/MINIAPP_WECHAT_ACCEPTANCE.md`、`SUPPORT_CHANNELS_IMPLEMENTATION.md`、`SELF_TEST_REPORT.md`、`IMPLEMENTATION_STATUS.md`、本清单。仅修复失败诊断丢失与同步异常回退，真实客服失败待定位；没有环境变量、迁移或服务器变更。上线前仍须新诊断版真机、正确账号/真人响应、另一设备、失败兜底及值班负责人核验，[明细](MINIAPP_WECHAT_ACCEPTANCE.md)。

最新支付确认切片（2026-10-04）：完整证据和上线前资金/真机门禁见[支付确认记录](WECHAT_PREPAY_IMPLEMENTATION.md)。本轮10文件：`.github/workflows/ci.yml`；`apps/api/scripts/verify-mall-flow.ts`（仅修正虚拟订单显示fixture）；`apps/miniapp/pages/orders/index.ts`、`index.js`、`index.wxml`；`scripts/verify-miniapp-payment.test.mjs`；`docs/WECHAT_PREPAY_IMPLEMENTATION.md`、`SELF_TEST_REPORT.md`、`IMPLEMENTATION_STATUS.md`、本清单。没有环境变量、数据库或服务器变更。

最新小程序切片：订单/服务页WXML表达式修复、4项页面回归、13项专项包边界测试与8模板生成器，文件及人工微信步骤见[小程序专项验收记录](MINIAPP_WECHAT_ACCEPTANCE.md)。没有数据库或服务器生产配置变更，不把编译通过记作成功上传。

最新客服确认门禁切片代码`6411b16`：API、环境模板、小程序提示与测试共16个代码/文档文件；随后只更新验收记录、README及本清单。完整19文件列表和人工核对见[最新接入记录](SUPPORT_CHANNELS_IMPLEMENTATION.md)。已按用户明确确认复用旧URL，仅开放私有客服入口，未做真机或公开经营验收。

最新轮次文件与人工检查见[短信/地图、企业微信客服和紧急值班接入记录](SUPPORT_CHANNELS_IMPLEMENTATION.md)。本轮没有新增迁移或公开上线，不提交用户电话号码和渠道凭据。

最新一轮是[旧商城清理与生产准备](LEGACY_RETIREMENT_20261004.md)：完整本轮文件清单、服务器执行证据及上线前人工核对项见该记录；下文保留此前MFA功能增量历史。本轮新增维护页/配置、受限一次性清理与生产准备工具，未提交任何数据库备份或密钥。

日期：2026-10-04。本轮在c270262e私有验收基线上新增验证器丢失受审恢复、第16批迁移、本人小程序申请、管理员后台复核和隔离HTTP/PostgreSQL专项测试；代码`e898cbf`已通过CI并部署到私有验收服务器。不提交密钥、运行配置、归档、node_modules或截图；真人微信和独立设备双人演练仍待完成。

## 本轮文件

- `.github/workflows/ci.yml`
- `DECISIONS.md`
- `README.md`
- `apps/admin-web/src/security.tsx`
- `apps/admin-web/src/styles.css`
- `apps/api/package.json`
- `apps/api/prisma/migrations/20261004070000_mfa_recovery/migration.sql`
- `apps/api/prisma/schema.prisma`
- `apps/api/scripts/verify-mfa-recovery.ts`
- `apps/api/src/auth/auth.module.ts`
- `apps/api/src/auth/mfa-recovery.controller.ts`
- `apps/api/src/auth/mfa-recovery.service.ts`
- `apps/miniapp/app.json`
- `apps/miniapp/pages/mfa-recovery/index.json`
- `apps/miniapp/pages/mfa-recovery/index.js`
- `apps/miniapp/pages/mfa-recovery/index.ts`
- `apps/miniapp/pages/mfa-recovery/index.wxml`
- `apps/miniapp/pages/mfa-recovery/index.wxss`
- `apps/miniapp/pages/profile/index.ts`
- `apps/miniapp/pages/profile/index.js`
- `apps/miniapp/pages/profile/index.wxml`
- `docs/CHANGE_FILES.md`
- `docs/DEPLOYMENT.md`
- `docs/DEPLOYMENT_ACCEPTANCE_20261004.md`
- `docs/ENV_VARIABLES.md`
- `docs/IMPLEMENTATION_STATUS.md`
- `docs/MFA_RECOVERY_IMPLEMENTATION.md`
- `docs/PRIVATE_ACCEPTANCE_DEPLOYMENT.md`
- `docs/SELF_TEST_REPORT.md`
- `docs/openapi.v1.yaml`
- `packages/contracts/src/index.ts`

## 上一轮文件（后台微信交接）

- `.env.example`
- `.github/workflows/ci.yml`
- `DECISIONS.md`
- `README.md`
- `apps/admin-web/src/browser-login.tsx`
- `apps/admin-web/src/main.tsx`
- `apps/admin-web/src/security.tsx`
- `apps/api/package.json`
- `apps/api/prisma/migrations/20261004052000_browser_login/migration.sql`
- `apps/api/prisma/schema.prisma`
- `apps/api/scripts/verify-browser-login.ts`
- `apps/api/src/auth/auth-crypto.service.ts`
- `apps/api/src/auth/auth.module.ts`
- `apps/api/src/auth/auth.service.ts`
- `apps/api/src/auth/browser-login.controller.ts`
- `apps/api/src/auth/browser-login.service.test.ts`
- `apps/api/src/auth/browser-login.service.ts`
- `apps/api/src/auth/wechat-miniapp.client.test.ts`
- `apps/api/src/auth/wechat-miniapp.client.ts`
- `apps/api/src/config/env.ts`
- `apps/miniapp/app.json`
- `apps/miniapp/pages/admin-login/index.js`
- `apps/miniapp/pages/admin-login/index.json`
- `apps/miniapp/pages/admin-login/index.ts`
- `apps/miniapp/pages/admin-login/index.wxml`
- `apps/miniapp/pages/admin-login/index.wxss`
- `apps/miniapp/pages/profile/index.js`
- `apps/miniapp/pages/profile/index.ts`
- `apps/miniapp/pages/profile/index.wxml`
- `docs/BROWSER_LOGIN_IMPLEMENTATION.md`
- `docs/CHANGE_FILES.md`
- `docs/DEPLOYMENT.md`
- `docs/DEPLOYMENT_ACCEPTANCE_20261004.md`
- `docs/ENV_VARIABLES.md`
- `docs/IMPLEMENTATION_STATUS.md`
- `docs/PRIVATE_ACCEPTANCE_DEPLOYMENT.md`
- `docs/SELF_TEST_REPORT.md`
- `docs/openapi.v1.yaml`
- `scripts/deploy-private-acceptance.sh`
- `scripts/serve-private-preview.mjs`

## 全部累计文件

- `.env.example`
- `.gitattributes`
- `.github/workflows/ci.yml`
- `.gitignore`
- `DECISIONS.md`
- `README.md`
- `apps/admin-web/src/browser-login.tsx`
- `apps/admin-web/src/main.tsx`
- `apps/admin-web/src/refunds.tsx`
- `apps/admin-web/src/security.tsx`
- `apps/admin-web/src/styles.css`
- `apps/admin-web/tsconfig.app.tsbuildinfo`
- `apps/api/package.json`
- `apps/api/prisma/migrations/20261003235000_refund_core/migration.sql`
- `apps/api/prisma/migrations/20261004000500_refund_consistency/migration.sql`
- `apps/api/prisma/migrations/20261004005000_refund_review_guards/migration.sql`
- `apps/api/prisma/migrations/20261004005500_refund_review_code_not_null/migration.sql`
- `apps/api/prisma/migrations/20261004014500_wechat_prepay/migration.sql`
- `apps/api/prisma/migrations/20261004022000_wechat_recovery/migration.sql`
- `apps/api/prisma/migrations/20261004031000_staff_mfa/migration.sql`
- `apps/api/prisma/migrations/20261004052000_browser_login/migration.sql`
- `apps/api/prisma/schema.prisma`
- `apps/api/prisma/seed.ts`
- `apps/api/scripts/bootstrap-production.ts`
- `apps/api/scripts/create-browser-fixture.ts`
- `apps/api/scripts/verify-browser-login.ts`
- `apps/api/scripts/verify-mall-flow.ts`
- `apps/api/scripts/verify-mfa-flow.ts`
- `apps/api/scripts/verify-wechat-payments.ts`
- `apps/api/src/auth/access-control.service.test.ts`
- `apps/api/src/auth/access-control.service.ts`
- `apps/api/src/auth/auth-crypto.service.ts`
- `apps/api/src/auth/auth.module.ts`
- `apps/api/src/auth/auth.service.test.ts`
- `apps/api/src/auth/auth.service.ts`
- `apps/api/src/auth/auth.types.ts`
- `apps/api/src/auth/browser-login.controller.ts`
- `apps/api/src/auth/browser-login.service.test.ts`
- `apps/api/src/auth/browser-login.service.ts`
- `apps/api/src/auth/mfa.controller.ts`
- `apps/api/src/auth/mfa.service.test.ts`
- `apps/api/src/auth/mfa.service.ts`
- `apps/api/src/auth/totp.test.ts`
- `apps/api/src/auth/totp.ts`
- `apps/api/src/auth/wechat-miniapp.client.test.ts`
- `apps/api/src/auth/wechat-miniapp.client.ts`
- `apps/api/src/config/env.test.ts`
- `apps/api/src/config/env.ts`
- `apps/api/src/main.ts`
- `apps/api/src/orders/order-state-machine.ts`
- `apps/api/src/orders/orders.service.test.ts`
- `apps/api/src/orders/orders.service.ts`
- `apps/api/src/payments/payment-gateway.service.test.ts`
- `apps/api/src/payments/payment-gateway.service.ts`
- `apps/api/src/payments/payment-reconciliation.controller.ts`
- `apps/api/src/payments/payment-reconciliation.service.test.ts`
- `apps/api/src/payments/payment-reconciliation.service.ts`
- `apps/api/src/payments/payments.module.ts`
- `apps/api/src/payments/payments.service.test.ts`
- `apps/api/src/payments/payments.service.ts`
- `apps/api/src/payments/refund-policy.test.ts`
- `apps/api/src/payments/refund-policy.ts`
- `apps/api/src/payments/refund-protocol.test.ts`
- `apps/api/src/payments/refund-reconciliation.worker.test.ts`
- `apps/api/src/payments/refund-reconciliation.worker.ts`
- `apps/api/src/payments/refunds.controller.ts`
- `apps/api/src/payments/refunds.service.test.ts`
- `apps/api/src/payments/refunds.service.ts`
- `apps/api/src/payments/trade-bill.test.ts`
- `apps/api/src/payments/trade-bill.ts`
- `apps/api/src/payments/wechat-pay.client.test.ts`
- `apps/api/src/payments/wechat-pay.client.ts`
- `apps/api/src/payments/wechat-pay.protocol.test.ts`
- `apps/api/src/payments/wechat-pay.protocol.ts`
- `apps/api/src/payments/wechat-payments.controller.test.ts`
- `apps/api/src/payments/wechat-payments.controller.ts`
- `apps/api/src/payments/wechat-payments.service.test.ts`
- `apps/api/src/payments/wechat-payments.service.ts`
- `apps/api/src/payments/wechat-prepay.service.test.ts`
- `apps/api/src/payments/wechat-prepay.service.ts`
- `apps/api/src/payments/wechat-recovery.service.test.ts`
- `apps/api/src/payments/wechat-recovery.service.ts`
- `apps/api/src/payments/wechat-recovery.worker.test.ts`
- `apps/api/src/payments/wechat-recovery.worker.ts`
- `apps/api/src/scheduling/scheduling.service.ts`
- `apps/miniapp/app.js`
- `apps/miniapp/app.json`
- `apps/miniapp/package.json`
- `apps/miniapp/pages/admin-login/index.js`
- `apps/miniapp/pages/admin-login/index.json`
- `apps/miniapp/pages/admin-login/index.ts`
- `apps/miniapp/pages/admin-login/index.wxml`
- `apps/miniapp/pages/admin-login/index.wxss`
- `apps/miniapp/pages/booking/index.js`
- `apps/miniapp/pages/booking/index.json`
- `apps/miniapp/pages/booking/index.ts`
- `apps/miniapp/pages/booking/index.wxml`
- `apps/miniapp/pages/booking/index.wxss`
- `apps/miniapp/pages/home/index.js`
- `apps/miniapp/pages/orders/index.js`
- `apps/miniapp/pages/orders/index.ts`
- `apps/miniapp/pages/orders/index.wxml`
- `apps/miniapp/pages/orders/index.wxss`
- `apps/miniapp/pages/profile/index.js`
- `apps/miniapp/pages/profile/index.ts`
- `apps/miniapp/pages/profile/index.wxml`
- `apps/miniapp/pages/services/index.js`
- `apps/miniapp/pages/services/index.ts`
- `apps/miniapp/pages/services/index.wxml`
- `apps/miniapp/pages/therapists/index.js`
- `apps/miniapp/tsconfig.build.json`
- `apps/miniapp/turbo.json`
- `apps/miniapp/types/global.d.ts`
- `apps/miniapp/utils/api.js`
- `apps/miniapp/utils/api.ts`
- `apps/miniapp/utils/auth.js`
- `apps/workbench-h5/tsconfig.app.tsbuildinfo`
- `docs/BROWSER_LOGIN_IMPLEMENTATION.md`
- `docs/CHANGE_FILES.md`
- `docs/DEPLOYMENT.md`
- `docs/DEPLOYMENT_ACCEPTANCE_20261004.md`
- `docs/ENV_VARIABLES.md`
- `docs/IMPLEMENTATION_STATUS.md`
- `docs/INTEGRATION_GATES.md`
- `docs/PRIVATE_ACCEPTANCE_DEPLOYMENT.md`
- `docs/REFUND_IMPLEMENTATION.md`
- `docs/SELF_TEST_REPORT.md`
- `docs/STAFF_MFA_IMPLEMENTATION.md`
- `docs/WECHAT_PAY_IMPLEMENTATION.md`
- `docs/WECHAT_PREPAY_IMPLEMENTATION.md`
- `docs/WECHAT_RECOVERY_IMPLEMENTATION.md`
- `docs/openapi.v1.yaml`
- `infra/database-init.sql`
- `infra/docker-compose.dev.yml`
- `infra/nginx.example.conf`
- `infra/zhongyuan-daojia.service`
- `packages/contracts/src/index.test.ts`
- `packages/contracts/src/index.ts`
- `scripts/database-init.ps1`
- `scripts/database-init.sh`
- `scripts/deploy-private-acceptance.sh`
- `scripts/serve-private-preview.mjs`
- `scripts/serve-private-preview.test.mjs`
- `scripts/setup-private-acceptance.mjs`
- `turbo.json`
