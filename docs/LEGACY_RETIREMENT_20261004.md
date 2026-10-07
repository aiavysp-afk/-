# 旧商城清理与新版生产准备实录

日期：2026-10-04。用户本轮明确授权全面删除 mtsc.top 旧商城数据；本记录取代此前“不得操作旧商城”的本轮范围限制，不扩大到其他业务或个人文件。公开经营尚未上线。

## 已完成及证据

- 先切换 mtsc.top、api.mtsc.top、admin.mtsc.top 到维护模式，HTTPS 主站与旧 API 均返回 503；保留 TLS 和 Certbot 原有 ACME webroot。
- 停止并禁用 jingxiang-api、jingxiang-admin、jingxiang-backup.timer；删除 PM2 的 mtsc-campus-api 并保存空进程清单。旧 3000/3001/8787 端口停止监听。
- jingxiang 的 52 张业务表、mtsc_campus 的 33 张表已清空，逐表数量校验为零；保留旧表结构与迁移历史。清理前没有已支付订单或退款，旧校园商城仅一笔待支付订单。
- 删除 16 个确认属于旧系统的 refresh 会话键，不执行 Redis FLUSHALL。删除旧商城全部 35 个上传文件。
- 清理旧应用 releases、staging、校园商城 backups/releases/current，以及 source-final.tar.gz；删除前已验证路径不是符号链接且确属旧商城。保留空 current/dist 仅供证书自动续期。
- 12 个 zy_prd_test_20261003_01 至 12 旧测试库逐一备份后删除；不删除其他数据库。
- 磁盘可用空间从 4,160,632 KiB 增至 35,892,192 KiB（生产库准备后），使用率由约 92% 降至 27%。约回收 30 GiB。
- 原私有验收 API/admin/H5 继续运行，API 回环健康检查 200；不把 Mock 验收服务反代到公网。

## 保留内容与恢复边界

这是在线旧商城数据清空和过期版本清理，**不是所有历史副本的不可恢复擦除**。微信密钥、TLS、受限备份和新版本代码保留。

删除前恢复归档：`/var/backups/zhongyuan-daojia-legacy-retirement/20261004T054600Z`，父目录/归档 0700、文件无组和其他用户权限；包含两套业务库、12 个旧测试库、上传文件、当前源码、旧配置、表行数及 SHA256SUMS。两套业务库都实际恢复到独立临时库，逐表行数与原库一致后才清空在线库；临时恢复库已删除。归档 SHA256 校验通过。

第一次维护切换因 nginx reload 后旧 worker 短暂仍返回 200 而安全停止，没有删除数据；`20261004T054400Z` 归档包含原 nginx 配置。第二次运行添加有界重试后完成；第二次的 nginx before 文件已是维护配置。需要恢复旧 vhost 时必须核对第一次归档，不得误用第二次快照。历史 `/var/backups/jingxiang` 受控备份也保留。

仅在管理员决定回退时恢复到**独立数据库**并核对，不直接覆盖新版库，不盲目重启旧系统；恢复旧源码需重新安装依赖、构建及核查微信状态。恢复材料含敏感数据，不下载到聊天或提交 Git。

## 已继续执行的新版准备

- 建立 `/opt/zhongyuan-daojia` 生产准备目录与专属 OWNER 标记；未建立运行 current 或启动公开生产进程。
- 独立数据库 `zhongyuan_daojia`、非超级用户角色 `zydj_app`，btree_gist 扩展及 16 批 Prisma 迁移通过，22 张业务表全部零行。不导入旧数据、不执行开发 seed、不伪造管理员。
- `/etc/zhongyuan-daojia/api.env.pending` 为 root-only 0600，目录 0700。独立随机数据库密码、会话 pepper 和 32 字节加密密钥；初始配置备份 `/opt/zhongyuan-daojia/backups/api.env.initial` 同为 0600，父目录 0700。后续配置变更需受控备份，不能丢失加密密钥。
- 从受控旧环境导入 AppSecret、商户号/APIv3、商户序列号及平台公钥 ID；证书与私钥复制到 `/etc/zhongyuan-daojia/certs`，文件 0600。验证 RSA 材料、商户证书未过期、序列号及证书私钥匹配，未发起任何真实支付请求。
- 生产身份/支付 provider 为 wechat，监听计划为 `127.0.0.1:3220`，与私有验收 3210 分离。回调计划为 `https://api.mtsc.top/v1/payments/wechat/notify` 和 `/v1/payments/wechat/refund-notify`，目前仍返回维护 503，**尚未验收可用**。
- STAFF_MFA_REQUIRED、STAFF_BROWSER_LOGIN_ENABLED 为 true，预下单/补偿/退款三个开关全部 false。
- production 配置门禁实测只报告 `SMS_PROVIDER, MAP_PROVIDER, SAFETY_HOTLINE`。短信/地图仍为 mock，热线为空，禁止将 pending 改名为 api.env 或启动公开服务来绕过。

## 顺序执行与人工检查

1. 真实微信登录、两名不同工作人员的后台 MFA、双人退款复核/恢复演练；核验小程序和商户主体/AppID 绑定、隐私和服务条款、正规服务范围、经营资质。
2. 完成技师 H5 实际履约和争议/服务开始后退款规则，确认真实商品、排班、服务区域、客服与应急人员；不发布演示指标为真实经营数据。
3. 构建固定 main 提交，配置专属运行账号只读权限与 systemd/备份/监控。API 使用 3220，不占用私有验收端口；管理后台需私网或身份网关。
4. 在隔离受控环境验收极小额真实支付/退款、重复通知、超时和 UNKNOWN 人工处置、账单核对，再依次批准资金开关。所有款项由两人财务检查。
5. 更新并审核 nginx 正式路由、`nginx -t`、HTTPS/微信合法域名、通知路径、备份恢复与回滚，最终才解除维护。现在 503 是刻意保护状态，不应视为已经上线。

## 仓库工具

- `scripts/retire-legacy-mall.sh`：针对本次已确认旧目录、库表数量和活动 release 的一次性工具。需要 root、CONFIRM_RETIRE_LEGACY_MALL=mtsc.top 和唯一审计 ID；**本次已经执行，禁止重跑**。
- `scripts/prepare-production.mjs`：一次性生产准备工具，需 root 与 CONFIRM_PREPARE_PRODUCTION=mtsc.top；存在目标目录、账号或库时拒绝覆盖/轮换。只有预期三项门禁缺失时才创建，失败应人工检查已完成阶段，不重跑。数据库/密钥生成和 migration 使用 stdin/env，不把密钥放 argv 或 Git。
- `infra/maintenance/`：已在服务器实装并通过 nginx 语法/公网 503 验证的维护页和配置。

## 本轮改动文件

- `.github/workflows/ci.yml`
- `README.md`
- `scripts/retire-legacy-mall.sh`
- `scripts/prepare-production.mjs`
- `infra/maintenance/index.html`
- `infra/maintenance/mtsc.top.conf`
- `infra/maintenance/legacy-subdomains.conf`
- `docs/LEGACY_RETIREMENT_20261004.md`
- `docs/CHANGE_FILES.md`
- `docs/DEPLOYMENT.md`
- `docs/ENV_VARIABLES.md`
- `docs/IMPLEMENTATION_STATUS.md`
- `docs/PRIVATE_ACCEPTANCE_DEPLOYMENT.md`
- `docs/SELF_TEST_REPORT.md`

服务器备份、数据库、运行环境文件不提交 Git。
