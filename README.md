# 中原到家

面向正规上门按摩 SPA、足部舒缓与养生放松的三端预约平台。当前仓库包含：

- `apps/miniapp`：微信原生小程序用户端
- `apps/workbench-h5`：技师移动工作台
- `apps/admin-web`：PC 运营管理后台
- `apps/api`：NestJS 模块化 API
- `packages/contracts`：跨端共享类型与校验

## 本地启动

1. 复制 `.env.example` 为 `.env`。
2. 启动基础设施：`docker compose -f infra/docker-compose.dev.yml up -d`。
3. 安装依赖：`pnpm install`。
4. 初始化数据库：`pnpm --filter @zydj/api prisma:generate`，然后 `pnpm --filter @zydj/api prisma:migrate`。
5. 启动三端 Web 与 API：`pnpm dev`。

默认地址：API `http://localhost:3100/v1`，管理后台 `http://localhost:5173`，技师工作台 `http://localhost:5174`。

微信支付、短信、地图和 SOS 值班链路默认是明确标识的开发模式。生产环境存在 mock 集成、空安全热线或缺失密钥时，API 会拒绝启动。

小程序“我的”页已接入 M1 登录入口。本地 `AUTH_PROVIDER=mock` 只用于开发，生产会强制要求微信 AppSecret、会话 pepper 和 32 字节数据加密密钥；真实值只通过服务器环境变量注入。

管理后台“服务项目”已读取 PostgreSQL 目录。执行开发种子时只有显式设置 `SEED_DEVELOPMENT_IDENTITIES=true` 才会创建本地运营、调度和技师演示身份及次日班次；这些身份和登录按钮不会作为生产管理员认证方案。

## 当前阶段

已完成工程基线、品牌视觉、公开配置、M1 微信登录/会话/RBAC、M2 实时目录/排班/占位/报价/订单及Mock支付，以及退款持久化、申请/独立复核、累计额度占用、并发幂等、结果回调/原单查询/恢复租约、一次记账与退款管理页面。小程序目录、预约、订单和退款申请已接入API。经营看板/技师H5仍是演示，真实JSAPI预下单尚未完成，真实退款POST默认关闭，不能直接宣称生产资金闭环验收。

交付入口：[环境变量](docs/ENV_VARIABLES.md)、[数据库角色初始化](infra/database-init.sql)、[数据库迁移脚本](scripts/database-init.ps1)、[完整部署与人工检查项](docs/DEPLOYMENT.md)、[退款设计](docs/REFUND_IMPLEMENTATION.md)、[全流程自测结果](docs/SELF_TEST_REPORT.md)、[改动文件清单](docs/CHANGE_FILES.md)。

全流程HTTP与小程序运行逻辑自测：在独立本地 `zhongyuan_daojia_test` 执行migration并设置 `MALL_TEST_DATABASE_URL`，先 `pnpm build` 再 `pnpm --filter @zydj/api test:mall`。脚本拒绝生产/远程目标，创建并清理自己的合成记录。GitHub Actions已加入相同验证步骤。

本地数据库支付验证可运行 `pnpm --filter @zydj/api exec tsx scripts/verify-wechat-payments.ts`，需显式设置 `PAYMENT_DB_TEST_URL` 指向本机 `zhongyuan_daojia` 开发库；程序创建自己的临时组织并在结束后清理。微信支付接入说明见 [支付通知与对账](docs/WECHAT_PAY_IMPLEMENTATION.md)。
