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

已完成工程基线、品牌视觉、公开配置、健康检查、技师工作台、运营看板、M1 微信登录/会话/RBAC，以及 M2 数据库目录、组织排班、并发安全占位、服务端报价、幂等订单状态机和 Mock 支付闭环。真实微信支付、完整订单履约和生产部署仍受 `docs/INTEGRATION_GATES.md` 所列条件约束。
