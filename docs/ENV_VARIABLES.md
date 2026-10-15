# 环境变量清单

安全通知使用两个独立门禁：`SAFETY_NOTIFICATION_DISPATCH_ENABLED=false` 控制自动发送，`SAFETY_NOTIFICATION_RECEIPT_QUERY_ENABLED=false` 只控制已受理记录的只读送达查询；provider 或凭据不会自动开启任一门禁。`SAFETY_DUTY_CONFIRMED` 继续由真人主备与通知运维验收控制；专项脚本只接受本机隔离库，CI 只使用 Actions 隔离测试库，禁止指向生产。

新增 `WECOM_CUSTOMER_SERVICE_CONFIRMED=false` 独立门禁：合法CorpID+客服URL不会自动开放；负责人核验同一企业、账号有效与小程序绑定后才可受控设true。用户已明确确认原服务器客服链接归属，本项不替代微信真机打开/接通验收，也不能把SAFETY_DUTY_CONFIRMED自动设true。

最新客服/渠道变量与校验见[本轮接入记录](SUPPORT_CHANNELS_IMPLEMENTATION.md)。用户选择企业微信日常客服和独立紧急值班手机；SAFETY_CONTACT_MODE=wecom需官方链接/CorpID、SAFETY_EMERGENCY_PHONE及人工值班确认，不再要求把客服URL放进SAFETY_HOTLINE。SMS/地图只改provider标签不能通过凭据门禁，真实调用开关默认关闭。

最新服务器状态：生产待完成配置为 `/etc/zhongyuan-daojia/api.env.pending`（0600），独立数据库 `zhongyuan_daojia`、API_HOST=127.0.0.1、API_PORT=3220。微信钥证已导入，三个资金开关false；SMS_PROVIDER/MAP_PROVIDER仍mock、SAFETY_HOTLINE为空，门禁拒绝生产启动。不能直接使用 pending 上线；见[清理与生产准备实录](LEGACY_RETIREMENT_20261004.md)。下表3210仅为旧示例，现已用于私有验收。

生产密钥只放 `/etc/zhongyuan-daojia/api.env` 和受控密钥目录，不提交 Git、不复制到小程序、前端、截图或日志。服务账号只读，建议目录750、文件640（root:zydj）；若仅root读取则600。加密主密钥必须单独备份，不能随意轮换，否则地址与身份无法解密。

| 变量                                      | 用途 / 本地默认          | 生产要求                                                                                                                                                                                                   |
| ----------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NODE_ENV                                  | development              | production                                                                                                                                                                                                 |
| DATABASE_URL                              | 本地专用PostgreSQL连接   | 独立账号/数据库，密码URL编码，远端要求TLS；不能使用旧商城库                                                                                                                                                |
| API_PORT                                  | 3100                     | 示例3210，确认端口空闲                                                                                                                                                                                     |
| API_HOST                                  | 127.0.0.1                | 127.0.0.1，通过反代访问                                                                                                                                                                                    |
| CORS_ORIGINS                              | 本地5173/5174            | 精确授权管理端/H5 HTTPS源，不能\*                                                                                                                                                                          |
| BRAND_NAME                                | 中原到家                 | 品牌名                                                                                                                                                                                                     |
| SERVICE_CITY                              | 郑州市                   | 地图地址提示与核验的唯一服务城市；客户端不能覆盖                                                                                                                                                           |
| AUTH_PROVIDER                             | mock                     | wechat                                                                                                                                                                                                     |
| WECHAT_MINIAPP_APP_ID                     | wxab76ea213eb6d01a       | 核对实际主体                                                                                                                                                                                               |
| WECHAT_MINIAPP_SECRET                     | 空                       | 小程序AppSecret，仅服务端                                                                                                                                                                                  |
| WECHAT_OFFICIAL_ACCOUNT_ID                | gh_a4b5f9d63539          | 仅公开标识，非登录/支付凭证                                                                                                                                                                                |
| TECHNICIAN_H5_ONBOARDING_ENABLED          | false                    | 独立技师入驻总门禁；公众号网页授权、真实短信与回调域名全部验收前必须保持false                                                                                                                              |
| TECHNICIAN_H5_APP_ID                      | 空                       | 公众号网页授权AppID，仅服务端；必须与网页授权域名及UnionID主体一致                                                                                                                                         |
| TECHNICIAN_H5_APP_SECRET                  | 空                       | 公众号AppSecret，仅存受控服务端配置，不写入H5、日志或仓库                                                                                                                                                  |
| TECHNICIAN_H5_ENTRY_URL                   | 固定自有HTTPS地址        | 生产仅接受 `https://mtsc.top/technician/onboarding/`，禁止查询参数、片段和外部跳转                                                                                                                         |
| TECHNICIAN_H5_OAUTH_CALLBACK_URL          | 固定自有HTTPS回调        | 生产仅接受 `https://api.mtsc.top/v1/technician/h5-onboarding/wechat/callback`，须登记为公众号网页授权回调                                                                                                  |
| AUTH_SESSION_TTL_SECONDS                  | 604800，最大2592000      | 按会话策略设定                                                                                                                                                                                             |
| AUTH_SESSION_PEPPER                       | 本地固定值               | 强随机，至少32字符；变更使旧会话和身份哈希失配，须设计迁移                                                                                                                                                 |
| DATA_ENCRYPTION_KEY_BASE64                | 本地零值                 | 32字节随机密钥的Base64；必须可靠备份                                                                                                                                                                       |
| PAYMENT_PROVIDER                          | mock                     | wechat，不等于已开通真实预下单                                                                                                                                                                             |
| WECHAT_PAY_PREPAY_ENABLED                 | false                    | 签名POST显式开关；须微信身份/HTTPS回调/受控验收，非provider标签自动开启                                                                                                                                    |
| STORED_VALUE_RECHARGE_ENABLED             | false                    | 储值充值独立开关；仅在充值回调入账和对账验收完成后开启，不随普通订单支付自动开放                                                                                                                            |
| WECHAT_PAY_RECOVERY_ENABLED               | false                    | 独立原单查询/幂等关单/再核实开关；12次上限，未确认保留预约，先隔离验收与人工值班                                                                                                                           |
| WECHAT_MCH_ID                             | 空                       | 商户号，与该AppID合法绑定                                                                                                                                                                                  |
| WECHAT_PAY_API_V3_KEY                     | 空                       | 32字符APIv3密钥                                                                                                                                                                                            |
| WECHAT_PAY_MERCHANT_SERIAL_NO             | 空                       | 商户证书序列号                                                                                                                                                                                             |
| WECHAT_PAY_PRIVATE_KEY_PATH               | 空                       | 商户私钥绝对路径，服务账号只读                                                                                                                                                                             |
| WECHAT_PAY_MERCHANT_CERT_PATH             | 空                       | 盘点/人工验收用途，当前代码不加载它                                                                                                                                                                        |
| WECHAT_PAY_PUBLIC_KEY_ID                  | 空                       | 推荐公钥模式，PUB*KEY_ID*\*                                                                                                                                                                                |
| WECHAT_PAY_PUBLIC_KEY_PATH                | 空                       | 与上述ID配对的微信平台公钥文件，不是商户公钥                                                                                                                                                               |
| WECHAT_PAY_PLATFORM_CERT_PATH             | 空                       | 平台证书兼容模式，与公钥模式二选一；人工轮换验收                                                                                                                                                           |
| WECHAT_PAY_NOTIFY_URL                     | 空                       | HTTPS `/v1/payments/wechat/notify`                                                                                                                                                                         |
| WECHAT_PAY_REFUND_ENABLED                 | false                    | 初始保持false；双人受控验收后才true                                                                                                                                                                        |
| WECHAT_PAY_REFUND_NOTIFY_URL              | 空                       | HTTPS `/v1/payments/wechat/refund-notify`，开启真实退款必填                                                                                                                                                |
| SMS_PROVIDER                              | mock                     | aliyun；只是渠道选择，不会自动授权真实发送                                                                                                                                                                 |
| SMS_SEND_ENABLED                          | false                    | 阿里云短信底层提交开关；仅受控渠道验收时开启                                                                                                                                                               |
| PHONE_VERIFICATION_SMS_ENABLED            | false                    | 登录/手机号绑定短信备用通道独立开关；不授权安全告警短信                                                                                                                                                    |
| CUSTOMER_SMS_LOGIN_ENABLED                | false                    | 匿名客户短信登录独立门禁；还要求上行发送门禁、手机号验证码门禁、已审核签名/验证码模板与服务端受限凭据全部就绪，不授予工作人员登录或资金权限 |
| SAFETY_NOTIFICATION_DISPATCH_ENABLED      | false                    | 安全Outbox自动投递独立开关；要求aliyun、SMS发送及真人值班门禁均通过                                                                                                                                        |
| SAFETY_NOTIFICATION_RECEIPT_QUERY_ENABLED | false                    | 已受理短信只读送达查询；要求aliyun及受限查询权限，不授权发送或重发                                                                                                                                         |
| ALIYUN_SMS_ACCESS_KEY_ID / SECRET         | 空                       | 受限RAM身份，只放服务端受控配置，不提交Git或前端                                                                                                                                                           |
| ALIYUN_SMS_SECURITY_TOKEN                 | 空                       | 可选STS临时令牌，须有受控刷新机制                                                                                                                                                                          |
| ALIYUN_SMS_SIGN_NAME                      | 空                       | 已审核且主体一致的短信签名                                                                                                                                                                                 |
| ALIYUN_SMS_TEMPLATE_CODE                  | 空                       | 已审核模板，变量必须为orderNo/category/stage/deadline                                                                                                                                                      |
| ALIYUN_SMS_PHONE_VERIFICATION_TEMPLATE_CODE | 空                     | 仅登录/手机号绑定验证码模板；当前审核通过值为 `SMS_512625587`，变量只能为 `code`                                                                                                                           |
| MAP_PROVIDER                              | mock                     | `amap`；仅选择渠道，还需独立开启地图门禁                                                                                                                                                                   |
| MAP_GEOCODING_ENABLED                     | false                    | 地址提示/核验的独立付费调用门禁；凭据、配额、服务区和隐私验收完成前保持false                                                                                                                               |
| SERVICE_AREA_ADCODE_ALLOWLIST             | 郑州全域 15 个代码       | `410102,410103,410104,410105,410106,410108,410122,410171,410172,410173,410181,410182,410183,410184,410185`；覆盖六区、中牟县、五个县级市及经开区、高新区、航空港区；启用后以高德逆解析返回的行政区代码校验 |
| AMAP_MINIAPP_KEY                          | 空                       | 微信小程序平台 Key；环境变量注入，只在地图门禁打开时通过公开配置下发                                                                                                                                       |
| AMAP_WEB_SERVICE_KEY                      | 空                       | Web 服务 API 后端 Key；只放服务器受控配置，不下发小程序                                                                                                                                                    |
| SAFETY_HOTLINE                            | 空                       | 经实际接通测试的值；标签不代表自动呼叫能力                                                                                                                                                                 |
| VITE_API_BASE_URL                         | http://127.0.0.1:3100/v1 | 构建管理端时提供HTTPS API地址，仅公开信息                                                                                                                                                                  |
| SEED_DEVELOPMENT_IDENTITIES               | false                    | 必须false；开发seed脚本禁止production及远程身份播种                                                                                                                                                        |
| MALL_TEST_DATABASE_URL                    | 无                       | 自测专用：仅本地zhongyuan_daojia_test，不使用生产库                                                                                                                                                        |
| PAYMENT_DB_TEST_URL                       | 无                       | 支付/预下单/退款数据库验证仅本地zhongyuan_daojia或zhongyuan_daojia_test；合成数据自动清理                                                                                                                  |
| SAFETY_TEST_DATABASE_URL                  | 无                       | 安全值班并发验证仅本机zhongyuan_safety_test；CI仅隔离测试库；禁止生产目标                                                                                                                                  |
| SAFETY_NOTIFICATION_TEST_DATABASE_URL     | 无                       | 安全通知并发/重试专项；仅本机两个隔离测试库；使用替身渠道，不发送真实短信                                                                                                                                  |
| CONFIRM_PRODUCTION_BOOTSTRAP              | 无                       | 手工一次性初始化时true，完成后移除                                                                                                                                                                         |
| BOOTSTRAP_ORGANIZATION_ID                 | 无                       | 初始化独立组织ID                                                                                                                                                                                           |
| BOOTSTRAP_REFUND_REQUESTER_USER_ID        | 无                       | 已经真实微信登录且人工核验的申请人UserID                                                                                                                                                                   |
| BOOTSTRAP_REFUND_APPROVER_USER_ID         | 无                       | 另一位已核验复核人，不能同一UserID                                                                                                                                                                         |
| REDIS_URL                                 | localhost:6379           | 预留变量，当前代码未消费；退款恢复由PostgreSQL租约完成                                                                                                                                                     |
| PUBLIC_BASE_DOMAIN                        | mtsc.top                 | 文档预留，当前代码未消费，不自动配置DNS                                                                                                                                                                    |

兼容旧服务器别名：`WECHAT_APPID`、`WECHAT_APP_SECRET`、`WECHAT_MCHID`、`WECHAT_API_V3_KEY`、`WECHAT_MCH_SERIAL_NO`、`WECHAT_PRIVATE_KEY_PATH`、`WECHAT_PLATFORM_SERIAL_NO`、`WECHAT_PLATFORM_CERT_PATH`。新部署只使用规范变量；禁止新旧商户/验签配置组混用。别名的识别不能证明旧服务器数据归属于本商城，须企业管理员核对。

小程序没有 Vite 环境变量：`apps/miniapp/app.ts` 当前已使用 `https://api.mtsc.top/v1`，运行 build 生成 JS；不要再切回手机无法访问的 localhost。开发工具启用合法域名校验，核对 AppID，上传包不含 node_modules、证书或 `.env`。profile 页另有仅含公开客服与值班电话的维护/断网兜底，成功服务器公开配置仍覆盖本地值。

## MFA增量变量

后台交接增量：`STAFF_BROWSER_LOGIN_ENABLED`默认false；仅受控验收显式true，production仅接受wechat第一因子且电脑接口要求受信HTTPS Origin。`BROWSER_LOGIN_TEST_DATABASE_URL`仅用于专用隔离HTTP/DB测试，目标限制与MFA测试相同。浏览器新会话最多一小时且不超过手机期限，没有可配置的角色、回调、设备秘钥或绕过MFA变量。见[交接交付](BROWSER_LOGIN_IMPLEMENTATION.md)。

| 变量                           | 用途与约束                                                                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| STAFF_MFA_REQUIRED             | 默认false，仅非生产开发可不强制；私有验收配置true。production无论该值如何均强制工作人员当前会话MFA，不是生产绕过开关。                    |
| MFA_TEST_DATABASE_URL          | 仅独立本机zhongyuan_daojia_test的HTTP/DB自测；私有服务器仅专用zydj_acceptance_smoke且CONFIRM_PRIVATE_ACCEPTANCE_TEST=true；禁止生产目标。 |
| MFA_RECOVERY_TEST_DATABASE_URL | 受审恢复专项HTTP/DB自测；允许目标与MFA_TEST_DATABASE_URL相同，脚本拒绝普通远程库和生产库。                                                |

MFA密钥沿用DATA_ENCRYPTION_KEY_BASE64加密，禁止更换该主密钥而不做受审迁移。没有默认验证器密钥、通用恢复码、关闭MFA或重置快捷变量；受审恢复也没有生产开关或复核绕过变量。详见[MFA交付](STAFF_MFA_IMPLEMENTATION.md)和[恢复交付](MFA_RECOVERY_IMPLEMENTATION.md)。

## 客户单弹窗登录增量

客户端普通客户入口为 `pages/phone-verification/index`，同一绿白弹窗纵向提供微信一键登录和手机号码登录。协议默认未勾选，只有明确勾选后才渲染原生 `getPhoneNumber` 按钮；微信登录码和用户授权的手机号码一起提交 `/auth/customer-login/wechat-phone`。后台以已验证手机号的服务端键控哈希复用原 `User.id`，不重写或叠加订单、余额、优惠券、消费流水；两个已经存在的不同用户 ID 或历史重复手机号必须人工核对，不能自动退休空壳账号。

客户短信登录使用独立的 `/auth/customer-login/sms/request` 与 `/sms/confirm`，不依赖微信会话。真实发送缺凭据时保持关闭，客户端可以查看手机号码表单，但不能发送验证码或伪造成功。验证码五分钟过期、六十秒冷却、最多五次错误、单次消费；手机号/IP/全局发送预算和服务器可信代理链限制成本与暴力尝试。`UNKNOWN` 只是发送结果不确定，不代表已送达。

短信会话仅拥有客户业务能力，绑定登录时的手机号哈希；后台换号后旧会话失效，同号验证时间刷新不使其失效。它不继承该用户的工作人员/MFA/技师能力，也不能借用旧微信 OpenID 支付。本人支付或充值时可显式进入 `forceChoice=1` 微信登录选择；旧待付订单和钱包保持不变。微信支付按本次会话的准确身份校验，而不是用户关联的第一条微信身份。工作人员、技师入驻及好友代付的原有本人确认和安全返程不变。

第 `20261014050000_customer_single_step_login` 批迁移是增量表/字段，不包含用户或资金记录改写。上线流程包括隔离数据库验收、配套接口/迁移/网关发布、本人微信真机验证及官方代码上传；不能只更新客户端、忘记部署接口和迁移。`CUSTOMER_AUTH_ACCEPTANCE_DATABASE_URL` 只接受 loopback 上专用 `zydj_customer_auth_acceptance_*` 空库；不得使用生产 `DATABASE_URL` 兜底。既有 `scripts/verify-staff-auth-isolated.ps1` 可用 `-Acceptance customer` 创建并清理独立数据库与随机受限角色，无真实短信发送、微信付款或用户资产变更。

2026-10-14 开发验收：API 906 项、小程序 250 项、契约 49 项测试通过，相关类型检查与构建通过；全部 37 批迁移在专用空 PostgreSQL 库应用成功，客户登录 15 组真实数据库验收通过。验证覆盖原用户订单/钱包/优惠券/流水逐字节保留、同手机号并发绑定、短信单次消费与费用门禁、历史重复账户拒绝自动合并、短信会话不能取得工作人员权限。并发遇到有限等待的 `LOGIN_BUSY` 时，只允许以新的微信登录码和手机号授权码重新尝试，不能重用已消费授权码。测试库与随机测试角色已清理，正式库与线上版本没有因此更改。

官方微信工具中的新登录页视觉检查与本轮小程序 `7.5.3` 代码上传已完成。仍未完成：本人真机微信手机号授权、真实短信渠道受控验收。短信凭据与签名/模板未就绪时继续保持 `CUSTOMER_SMS_LOGIN_ENABLED=false`，不能把本地测试或上传成功表述为短信可用。部署前保留正式库备份与旧版本回退点，增量迁移先于新版 API，再核对匿名能力接口与现有会话兼容性，最后上传配套小程序；不回删增量字段，也不在回退时改写客户资产。

配套生产网关必须部署本轮 `infra/nginx.production.conf` 的四个精确客户登录路由。只更新 API 或小程序会被旧网关的默认 404 拦截。新版发布脚本要求四个路由标记，并用能力 GET、缺字段的空 JSON POST、错误方法与未知子路径检查代理边界；探针不提交微信授权码、不发短信、不创建用户。既有后台来源网段、MFA 和财务路由保持不变；Nginx 发布还要求配套私有后台为同一提交版本，不能跳过该版本检查。2026-10-14 本地网关及发布70项回归通过，配套正式 Nginx 已切换。

### 2026-10-14 配套服务器部署记录

- 源码 `bd978ae4a53bcba9915bcbb8eee7bf9808be675a` 已推送现有 `codex/technician-profile-sync` 分支；API、私有管理端和技师H5的进程/current均核对同一版本，三个服务为active。没有改写或强推main。
- 正式库迁移前备份为服务器 `/opt/zhongyuan-daojia/backups/database-before-bd978ae4a53bcba9915bcbb8eee7bf9808be675a-20261014T023633.dump`，961248字节、0600权限，`pg_restore --list` 已验证；37批迁移全部成功。原应用回退点 `ea33e1d27f08cbfad35b5a86934f15f5461da1d7` 与网关备份保留，禁止回删增量表或把旧备份覆盖正在产生交易的在线库。
- 正式环境文件与管理员来源白名单文件部署前后SHA-256一致；没有启用客户/后台短信、修改财务开关、修改角色或重置MFA。
- 本机公网TLS探针：能力GET为200且微信手机号登录true、短信false；微信手机号与两种短信登录POST的非法空JSON均为400；能力HEAD为404、手机号GET为403、额外后缀为404；匿名客户中心、订单、技师工作台与auth/me均为401；旧微信登录空JSON仍为400。
- 本机属于既有授权来源，管理API匿名401不能证明非白名单外网403。网关内网探针成功；独立非白名单网络的管理站点503/API管理403仍待外部复核，不能把公共抓取工具“不可访问”当作HTTP状态证明。
- 工程启动的代码信任提示由本人处理；工具恢复后已观察首页和未登录业务跳转的新绿白登录页，两个按钮纵向排列，协议未默认勾选。没有替本人点击微信手机号授权、短信验证码或安全确认；微信手机号真实授权验收不能用服务端探针代替。

### 2026-10-14 小程序7.5.3上传与短信状态

- 用户本人明确确认“覆盖体验版并上传新版”后，官方工具的体验版覆盖提示已确认，版本输入 `7.5.3`，并收到“代码上传成功”回执。未提交微信正式审核或发布，未修改工作人员或技师入驻启动路径；公众平台版本管理及长期独立体验码未单独复核，不能把上传成功替代这些验证。
- 客户端源码 `f0cb1ba1a25073a6b7b52e3f948360a41177a6a0` 的业务代码与已部署API版本一致，仅额外在 `packOptions.ignore` 排除 `node_modules` 和 `.turbo`；本地private config和output材料不提交。
- 同一工程的官方CLI正常生成临时预览二维码，AppID核对尾号 `d01a`，预览代码包446105字节（435.6KB）。原始PNG与上传成功截图保留在本地 `output/customer-login-preview-7.5.3-20261014.png`、`output/customer-login-upload-success-7.5.3-20261014.png`；不提交二维码到GitHub，不把临时预览码称为长期体验码。
- 只读复核：后台 `/auth/staff-password/config` 为 `enabled=false,smsEnabled=false`；客户能力为 `smsLoginEnabled=false`。服务器短信provider为none，短信发送、旧手机号验证、客户SMS和后台密码SMS四个开关均关闭；专用短信RAM凭据缺失，签名/模板字段存在但平台审核状态未核验。原因是未开通发送，而不是已发送未收到。
- 微信后台主登录与强制MFA仍开启。后台密码短信还要求已有工作人员身份、已验证手机号、本人先经微信/MFA设置密码；客户手机号登录不会授予后台权限。本轮未发短信、创建RAM身份或更改收费渠道/资金/权限开关。

### 2026-10-15 三端排查修复记录

- 修复5项确认缺陷：旧/匿名请求的延迟401不再清除新登录会话；跨技师时段按开始/结束时间及技师ID稳定排序；过期预约清理锁定并复核订单后，仅对实际取消的未付订单返券；预约页按`fulfillmentReviewRequired`提示到账后仍需平台核实，不能误报预约生效；历史/邀请技师审核也严格核对已传入的`expectedVersion`，保留原无版本兼容及更新CAS。
- 过期订单返券复用现有规则：有效券恢复AVAILABLE、过期券转EXPIRED。微信原单尚未核实、已付款、付款期限延长、订单/占位关系不匹配或未实际取消时，均不返券或释放占位。不改变支付、退款或入驻审批规则。
- 本地完整构建通过；API79文件919项、PC管理端83项、技师H5端54项、共享契约49项通过；全脚本使用`--test-concurrency=1`复测405/405通过。早先与构建并跑的Bash模拟探针曾发生本机5秒子进程超时，独立串行复测全部通过，未以放宽超时或跳过测试消除失败。
- 新增临时隔离PostgreSQL验收7组通过：空库/受限账号/37批迁移，无支付与MOCK订单的有效及过期券返还，合成WECHAT/PENDING原单保留，跨技师时段排序。未导入生产环境配置，未调用微信/短信/资金网络接口；随机测试库、受限角色、隧道和临时schema均已清理，另行只读确认测试库及角色计数为0。验收脚本留在本地output，不打包上传小程序或提交Git。
- 不可变源码`f01ee5482e18f4ad1caeab14b6a1dc3989c688a4`已推送现有分支，并部署API、独立私有管理端、技师H5及精确Nginx网关；三个current链接均为此版本，API/管理服务/Nginx均active。本轮没有新增迁移，正式库37批迁移无待应用；没有清理或改写真实订单、钱包或客户资料。
- 部署前正式库备份：`/opt/zhongyuan-daojia/backups/database-before-f01ee5482e18f4ad1caeab14b6a1dc3989c688a4-20261015T090829.dump`，973553字节、0600权限，`pg_restore --list`再次验证可读。旧`bd978ae4a53bcba9915bcbb8eee7bf9808be675a`应用回退点保留，不以旧库覆盖在线交易数据。
- 正式环境文件及后台来源白名单的部署前后SHA-256一致。未启用客户/后台短信，未修改资金开关、MFA、可信设备规则、账号权限或审核真人申请。当前机器访问后台与技师H5为200；API健康、目录、公开技师、客户登录能力及后台密码能力为200，匿名客户中心/订单/技师入驻/工作台/auth-me为401。非白名单独立网络验证仍未完成，不能用本机授权来源的200或内网探针替代。
- 只读数据核对：8个公开项目；1份PENDING_REVIEW申请、2份私密证件记录、2张形象照、3条CANCELLED订单均保留；取消且无支付订单占用券数为0。没有PUBLISHED技师，因此公开技师数0符合审核/发布门禁，而不是资料丢失。部署前24小时日志样本未见5xx，样本中5条error级事件均为未登录探针的401；不据此宣称所有真人业务已验收。
- 同源码小程序官方CLI临时预览成功，AppID尾号d01a，代码包446412字节；PNG位于本地`output/miniapp-fixes-f01ee54-preview-20261015.png`。用户随后明确确认“覆盖体验版并上传7.5.4”，官方CLI以版本7.5.4成功上传，回执`upload`成功、退出码0，上传包447605字节（437.1KB），原始元数据保留在本地`output/miniapp-upload-7.5.4-20261015.json`。上传后另生成官方临时检查码`output/miniapp-preview-7.5.4-20261015.png`，预览包仍为446412字节；不将临时码称为长期体验码。已执行本次体验版覆盖上传，未正式审核或发布；公众平台版本管理及长期独立体验码未单独复核。
- 上传前只读复核：业务源码和编译JS均与`f01ee5482e18f4ad1caeab14b6a1dc3989c688a4`一致，25个页面、AppID尾号d01a、首页及技师/工作人员启动路径不变；忽略node_modules/.turbo、域名校验开启、源码图上传关闭。仅此前私有配置末尾换行和旧工作人员文档脏改动保留，未混入本轮代码提交。真实微信手机号授权、后台本人MFA及真机支付仍需本人验收，不能用模拟测试或代码上传成功替代。
