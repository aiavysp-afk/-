# 完整部署步骤与发布门禁

## 当前可发布范围

已实现本地Mock商城链路及退款核心、微信支付验签/查单、JSAPI持久化签名预下单/RSA调起参数、原单查单/幂等关单/再次核实及有限恢复、退款签名POST、退款通知/原单查询/恢复租约/对账差异，以及后台MFA、微信到浏览器登录交接和丢失验证器受审恢复。三个资金开关显式默认关闭。**不能直接作为真实经营版上线**：真实资金验收和人工异常修正未完成，真人微信/MFA设备仍未验收，技师H5/经营概览仍是演示，短信、地图、热线处置链路未完成，服务开始后的部分退款/争议规则未定义。修改provider标签或开关不会补齐这些能力。

2026-10-04已在120.55.187.102完成独立私有验收部署，当前基线c270262e、专用库15批迁移、STAFF_MFA_REQUIRED=true、浏览器交接门禁true，备份恢复和四套HTTP/DB流程通过；见[验收记录](DEPLOYMENT_ACCEPTANCE_20261004.md)。第16批受审恢复先在本地两库验证，须在本提交CI成功、远程备份和私有smoke验证后才能更新此服务器。沿用服务器PostgreSQL16.15，不更换原数据库服务；本地/CI使用17。未操作原生产商城服务，不能覆盖现有商城或直接复用其数据库。以下公开生产步骤仍须先消除门禁并经人工签字。

## 1. 发布前盘点与备份

1. 企业管理员确认服务器120.55.187.102归属、mtsc.top备案/域名控制权、小程序及商户主体/绑定权限、证书和APIv3材料所有权。只在服务器受控环境填入密钥，不在聊天中发送。
2. 保存现有Nginx配置、进程/端口、磁盘、数据库备份与恢复演练结果。确认3210未占用；建立新目录 `/opt/zhongyuan-daojia`、新系统账号zydj和独立数据库，不修改已有商城目录。
3. 选择独立API域名（示例zydj-api.mtsc.top，仅示例尚未确认DNS）、私有管理域名、TLS证书。外部开放443，SSH限管理员IP，Postgres/Redis/3210禁止公网访问。
4. 安装Node.js24、pnpm11.19.0、PostgreSQL17（与本地测试一致），并记录实际运行路径。systemd示例ExecStart必须改为实机Node绝对路径。在隔离验收环境运行本文所有检查后再考虑生产。

## 2. 检出指定main提交并构建

```bash
git clone https://github.com/aiavysp-afk/-.git /opt/zhongyuan-daojia/releases/<release-id>
cd /opt/zhongyuan-daojia/releases/<release-id>
git checkout main
git pull --ff-only
git rev-parse HEAD
pnpm install --frozen-lockfile
pnpm --filter @zydj/api exec prisma generate
pnpm typecheck
pnpm test
VITE_API_BASE_URL=https://zydj-api.mtsc.top/v1 pnpm build
```

生产包编译会移除DEV模拟账号按钮。不要把验收库连接或生产密钥打进前端产物。不要在运行中的Windows Prisma进程上覆盖生成DLL；先停该应用再generate。

## 3. 数据库初始化与迁移

数据库管理员先确认目标库不存在其他业务表、角色为独立商城账号，然后在数据库主机执行：

```bash
psql -X -v ON_ERROR_STOP=1 -d postgres -f infra/database-init.sql
psql -X -d postgres
# 在交互psql里执行 \password zydj_app，设置强密码，不进入命令行参数/历史
```

脚本只创建独立角色/库及btree_gist扩展，不清库、不设置硬编码密码。若同名库已存在，先人工检查归属再运行；不得用于旧业务库。表结构的唯一来源是 `apps/api/prisma/migrations/` 完整版本链。

将受控DATABASE_URL导入当前迁移进程，不回显：

```bash
bash scripts/database-init.sh
# Windows：powershell -File scripts/database-init.ps1 -GenerateClient
```

生产禁止 `migrate dev`、`db push`、`migrate reset`、开发seed。迁移会增加行锁/触发器，应评估数据量，在维护窗口应用；先备份并在副本验证已有数据一致性。迁移失败立即停止，不手工编辑已应用migration校验和。

## 4. 安全配置、初始组织和双人财务角色

[MFA基础](STAFF_MFA_IMPLEMENTATION.md)、第15批[浏览器交接](BROWSER_LOGIN_IMPLEMENTATION.md)与第16批[丢失恢复](MFA_RECOVERY_IMPLEMENTATION.md)均已实现。production工作人员权限始终要求当前会话五分钟内的MFA。STAFF_MFA_REQUIRED仅用于非生产显式验收，不能关闭生产门禁。真人微信、独立设备与双人恢复演练仍阻止公开经营；不能使用粘贴token或固定code代替。

按 [环境变量清单](ENV_VARIABLES.md) 创建 `/etc/zhongyuan-daojia/api.env`，密钥只读；`NODE_ENV=production`、`API_HOST=127.0.0.1`、`API_PORT=3210`，所有真实provider、加密密钥、验签材料和热线必须经过核验。`WECHAT_PAY_PREPAY_ENABLED=false`、`WECHAT_PAY_REFUND_ENABLED=false`、`WECHAT_PAY_RECOVERY_ENABLED=false`。生产启动门禁不通过时必须修复缺项，不可改成development来规避。独立私有验收环境可明确使用test/Mock，但只能监听回环地址，不能冒充生产经营版。

生产管理端须先接入正式登录和MFA，目前不能用开发固定code登录生产。两位真实微信用户完成登录后，由企业管理员核验身份，再把UserID填入一次性BOOTSTRAP变量，执行：

```bash
pnpm --filter @zydj/api exec tsx scripts/bootstrap-production.ts
```

脚本要求production和显式CONFIRM、两位不同已存在用户，只增加组织/独立财务会员/未上架新目录；不赋全局ADMIN、不覆盖价格、不发起资金交易。完成后移除BOOTSTRAP和CONFIRM变量，审查audit记录。商品上架、实际技师/排班和运营权限需另行审核配置，禁止用开发身份seed替代。

## 5. 启动、反向代理与健康检查

1. 将current符号链接指向验收过的release目录，保留上一版本；复制审核后的 `infra/zhongyuan-daojia.service` 到systemd，核对账号/Node路径/env读取权限。安装为新服务，不能覆盖旧服务。
2. 使用 `systemctl daemon-reload`、`systemctl enable --now zhongyuan-daojia`，检查 `systemctl status zhongyuan-daojia` 和脱敏日志。`curl --fail http://127.0.0.1:3210/v1/health`。
3. 新建Nginx独立vhost，参考 `infra/nginx.example.conf`；先准备DNS和证书，然后 `nginx -t` 通过才reload。不要改动mtsc.top现有主站vhost。Webhook不能套管理员登录；管理端必须私网/VPN或独立身份网关，不能仅靠CORS。
4. `curl --fail https://zydj-api.mtsc.top/v1/health`，验证HTTPS证书、无目录泄露、数据库端口不可公网连入。健康接口只证明进程存活，还需真实授权登录、数据库读写验收。
5. 管理端静态发布 `apps/admin-web/dist`；H5 `apps/workbench-h5/dist` 仍为演示，不能标为履约系统。不要使用vite dev服务器上线。

## 6. 小程序与微信支付验收

1. 在微信公众平台配置合法request域名、隐私保护指引、服务协议/退款规则与客服入口；上传前将app.ts改为HTTPS地址，build生成app.js/pages/utils JS；开发工具打开合法域名校验。
2. 核对AppID、商户号绑定、APIv3/商户证书及私钥、平台验签公钥ID或证书、通知URL、NTP时间同步、证书轮换流程。
3. JSAPI和原单补偿代码已完成，三个开关保持false。在真实微信登录、AppID/商户绑定、HTTPS回调、资金责任签字及异常值班就绪后，仅隔离受控验收环境允许分别开启WECHAT_PAY_PREPAY_ENABLED/WECHAT_PAY_RECOVERY_ENABLED。先极小额订单，验证SDK取消/失败/超时/重复回调、双实例恢复和关单/到账竞态。DISPATCHING/UNKNOWN/遗留NONE不重新预下单；204、NOTPAY、订单不存在和网络异常不释放预约，必须原单验签CLOSED。未完成真机资金及人工处置验收仍阻止公开生产收款。
4. 退款开关仅在正式双人复核、业务规则批准、回调可达、监控/人工值班就绪后开启。先极小额受控订单；申请人不能审核自己；额度由服务器计算。
5. 真实POST超时会变UNKNOWN并保留额度；进程在POST前/后崩溃均不自动再次POST，只查原out_refund_no。PROCESSING/UNKNOWN/ABNORMAL退避查询最多12次，CLOSED转人工。若微信明确未受理/关闭，当前没有自动解冻/重发接口，必须财务核实后开发受审修正流程，不能直接改库或另建单。
6. 已成功退款只能一次计账，退款成功后对账差异必须为0或经签字解释；微信与数据库状态不一致立即停止新资金业务，保留审计。

## 7. 自测、监控与回滚

- 在独立本地 `zhongyuan_daojia_test` 应用完整migration，设置MALL_TEST_DATABASE_URL后执行 `pnpm --filter @zydj/api test:mall`。脚本拒绝远程/生产目标，合成测试记录自动删除；不能替代真机/真实微信资金验收。
- 监控500/503、退款UNKNOWN/ABNORMAL/CLOSED、恢复attempt12、outbox未处理积压、数据库预算/成功记账一致性、磁盘/证书/备份。当前outbox只是持久化事件，没有投递消费者或自动告警平台，必须人工或运维监控落地后上线。
- 每日授权财务按组织核对交易账单；账单不可代替退款查单。时区Asia/Shanghai，跨日退款按原单号关联；未核对新金额、部分退款、失败/关闭不得标成功。
- 回滚先关闭退款开关并停止新交易，保留数据库和待查退款，不删除账簿。只可切回经兼容测试、仍强制工作人员MFA的应用release并重启；禁止生产回滚到不含MFA门禁的旧代码。新增migration不自动降级、不drop表，不删MfaCredential或改计数来解锁。对恢复/校验故障应从备份恢复到独立新库核对，再由管理员决定切换，不能盲目覆盖已发生支付/退款后的在线库。

## 上线前人工核对检查项

最新[微信后台安全交接](BROWSER_LOGIN_IMPLEMENTATION.md)已部署私有基线；[受审恢复](MFA_RECOVERY_IMPLEMENTATION.md)完成代码与本地隔离验证。正式启用必须先完成第16批专用库备份迁移，再做双人微信真机及独立MFA设备演练。默认STAFF_BROWSER_LOGIN_ENABLED=false，不与任何支付开关联动。

- [ ] 主体、备案/域名、服务资质与非医疗服务边界、隐私/地址使用授权、价格/差旅费及退款策略由负责人审核。
- [ ] 当前仓库列出的生产阻断项全部解决；管理端正式登录/MFA、客服/值班、技师履约、安全处置能真正完成，非演示。
- [ ] 独立目录/端口/库，旧商城不受影响，备份恢复演练通过，密钥可恢复且没有进入Git。
- [ ] 双人角色是不同自然人；权限跨组织/自审拒绝，资金审核留痕，禁止共享ADMIN和token。
- [ ] 微信主体绑定/证书/验签/HTTPS回调/时间同步及换证验证通过；退款开关初始false。
- [ ] 真机登录、商品浏览、时段竞争、地址确认、下单、支付、订单、退款到账与对账全部受控验收；生产无mock按钮与接口。
- [ ] UNKNOWN/异常/关闭及崩溃恢复有明确人工处理责任人，禁止另建退款号；上线监控/告警及outbox消费方案落地。
- [ ] 开始后、部分退款、争议及用户投诉策略另行批准；本版本自动规则只覆盖开始前剩余额度全退/已记录的迟到支付。
- [ ] 发布commit、migration版本、验收结果、回滚负责人和维护窗口已登记。
