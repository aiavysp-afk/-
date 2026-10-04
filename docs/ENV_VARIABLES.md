# 环境变量清单

新增 `WECOM_CUSTOMER_SERVICE_CONFIRMED=false` 独立门禁：合法CorpID+客服URL不会自动开放；负责人核验同一企业、账号有效与小程序绑定后才可受控设true。用户已明确确认原服务器客服链接归属，本项不替代微信真机打开/接通验收，也不能把SAFETY_DUTY_CONFIRMED自动设true。

最新客服/渠道变量与校验见[本轮接入记录](SUPPORT_CHANNELS_IMPLEMENTATION.md)。用户选择企业微信日常客服和独立紧急值班手机；SAFETY_CONTACT_MODE=wecom需官方链接/CorpID、SAFETY_EMERGENCY_PHONE及人工值班确认，不再要求把客服URL放进SAFETY_HOTLINE。SMS/地图只改provider标签不能通过凭据门禁，真实调用开关默认关闭。

最新服务器状态：生产待完成配置为 `/etc/zhongyuan-daojia/api.env.pending`（0600），独立数据库 `zhongyuan_daojia`、API_HOST=127.0.0.1、API_PORT=3220。微信钥证已导入，三个资金开关false；SMS_PROVIDER/MAP_PROVIDER仍mock、SAFETY_HOTLINE为空，门禁拒绝生产启动。不能直接使用 pending 上线；见[清理与生产准备实录](LEGACY_RETIREMENT_20261004.md)。下表3210仅为旧示例，现已用于私有验收。

生产密钥只放 `/etc/zhongyuan-daojia/api.env` 和受控密钥目录，不提交 Git、不复制到小程序、前端、截图或日志。服务账号只读，建议目录750、文件640（root:zydj）；若仅root读取则600。加密主密钥必须单独备份，不能随意轮换，否则地址与身份无法解密。

| 变量                               | 用途 / 本地默认          | 生产要求                                                                                  |
| ---------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------- |
| NODE_ENV                           | development              | production                                                                                |
| DATABASE_URL                       | 本地专用PostgreSQL连接   | 独立账号/数据库，密码URL编码，远端要求TLS；不能使用旧商城库                               |
| API_PORT                           | 3100                     | 示例3210，确认端口空闲                                                                    |
| API_HOST                           | 127.0.0.1                | 127.0.0.1，通过反代访问                                                                   |
| CORS_ORIGINS                       | 本地5173/5174            | 精确授权管理端/H5 HTTPS源，不能\*                                                         |
| BRAND_NAME                         | 中原到家                 | 品牌名                                                                                    |
| AUTH_PROVIDER                      | mock                     | wechat                                                                                    |
| WECHAT_MINIAPP_APP_ID              | wxab76ea213eb6d01a       | 核对实际主体                                                                              |
| WECHAT_MINIAPP_SECRET              | 空                       | 小程序AppSecret，仅服务端                                                                 |
| WECHAT_OFFICIAL_ACCOUNT_ID         | gh_a4b5f9d63539          | 仅公开标识，非登录/支付凭证                                                               |
| AUTH_SESSION_TTL_SECONDS           | 604800，最大2592000      | 按会话策略设定                                                                            |
| AUTH_SESSION_PEPPER                | 本地固定值               | 强随机，至少32字符；变更使旧会话和身份哈希失配，须设计迁移                                |
| DATA_ENCRYPTION_KEY_BASE64         | 本地零值                 | 32字节随机密钥的Base64；必须可靠备份                                                      |
| PAYMENT_PROVIDER                   | mock                     | wechat，不等于已开通真实预下单                                                            |
| WECHAT_PAY_PREPAY_ENABLED          | false                    | 签名POST显式开关；须微信身份/HTTPS回调/受控验收，非provider标签自动开启                   |
| WECHAT_PAY_RECOVERY_ENABLED        | false                    | 独立原单查询/幂等关单/再核实开关；12次上限，未确认保留预约，先隔离验收与人工值班          |
| WECHAT_MCH_ID                      | 空                       | 商户号，与该AppID合法绑定                                                                 |
| WECHAT_PAY_API_V3_KEY              | 空                       | 32字符APIv3密钥                                                                           |
| WECHAT_PAY_MERCHANT_SERIAL_NO      | 空                       | 商户证书序列号                                                                            |
| WECHAT_PAY_PRIVATE_KEY_PATH        | 空                       | 商户私钥绝对路径，服务账号只读                                                            |
| WECHAT_PAY_MERCHANT_CERT_PATH      | 空                       | 盘点/人工验收用途，当前代码不加载它                                                       |
| WECHAT_PAY_PUBLIC_KEY_ID           | 空                       | 推荐公钥模式，PUB*KEY_ID*\*                                                               |
| WECHAT_PAY_PUBLIC_KEY_PATH         | 空                       | 与上述ID配对的微信平台公钥文件，不是商户公钥                                              |
| WECHAT_PAY_PLATFORM_CERT_PATH      | 空                       | 平台证书兼容模式，与公钥模式二选一；人工轮换验收                                          |
| WECHAT_PAY_NOTIFY_URL              | 空                       | HTTPS `/v1/payments/wechat/notify`                                                        |
| WECHAT_PAY_REFUND_ENABLED          | false                    | 初始保持false；双人受控验收后才true                                                       |
| WECHAT_PAY_REFUND_NOTIFY_URL       | 空                       | HTTPS `/v1/payments/wechat/refund-notify`，开启真实退款必填                               |
| SMS_PROVIDER                       | mock                     | aliyun（配置标签；短信适配器尚未完成，不能据此宣称短信可用）                              |
| MAP_PROVIDER                       | mock                     | tencent（配置标签；地图适配器尚未完成）                                                   |
| SAFETY_HOTLINE                     | 空                       | 经实际接通测试的值；标签不代表自动呼叫能力                                                |
| VITE_API_BASE_URL                  | http://127.0.0.1:3100/v1 | 构建管理端时提供HTTPS API地址，仅公开信息                                                 |
| SEED_DEVELOPMENT_IDENTITIES        | false                    | 必须false；开发seed脚本禁止production及远程身份播种                                       |
| MALL_TEST_DATABASE_URL             | 无                       | 自测专用：仅本地zhongyuan_daojia_test，不使用生产库                                       |
| PAYMENT_DB_TEST_URL                | 无                       | 支付/预下单/退款数据库验证仅本地zhongyuan_daojia或zhongyuan_daojia_test；合成数据自动清理 |
| CONFIRM_PRODUCTION_BOOTSTRAP       | 无                       | 手工一次性初始化时true，完成后移除                                                        |
| BOOTSTRAP_ORGANIZATION_ID          | 无                       | 初始化独立组织ID                                                                          |
| BOOTSTRAP_REFUND_REQUESTER_USER_ID | 无                       | 已经真实微信登录且人工核验的申请人UserID                                                  |
| BOOTSTRAP_REFUND_APPROVER_USER_ID  | 无                       | 另一位已核验复核人，不能同一UserID                                                        |
| REDIS_URL                          | localhost:6379           | 预留变量，当前代码未消费；退款恢复由PostgreSQL租约完成                                    |
| PUBLIC_BASE_DOMAIN                 | mtsc.top                 | 文档预留，当前代码未消费，不自动配置DNS                                                   |

兼容旧服务器别名：`WECHAT_APPID`、`WECHAT_APP_SECRET`、`WECHAT_MCHID`、`WECHAT_API_V3_KEY`、`WECHAT_MCH_SERIAL_NO`、`WECHAT_PRIVATE_KEY_PATH`、`WECHAT_PLATFORM_SERIAL_NO`、`WECHAT_PLATFORM_CERT_PATH`。新部署只使用规范变量；禁止新旧商户/验签配置组混用。别名的识别不能证明旧服务器数据归属于本商城，须企业管理员核对。

小程序没有Vite环境变量：上传前修改 `apps/miniapp/app.ts` 的 `apiBaseUrl` 为HTTPS API地址，然后运行build生成JS；开发工具启用合法域名校验，核对AppID，上传包不含node_modules、证书或.env。

## MFA增量变量

后台交接增量：`STAFF_BROWSER_LOGIN_ENABLED`默认false；仅受控验收显式true，production仅接受wechat第一因子且电脑接口要求受信HTTPS Origin。`BROWSER_LOGIN_TEST_DATABASE_URL`仅用于专用隔离HTTP/DB测试，目标限制与MFA测试相同。浏览器新会话最多一小时且不超过手机期限，没有可配置的角色、回调、设备秘钥或绕过MFA变量。见[交接交付](BROWSER_LOGIN_IMPLEMENTATION.md)。

| 变量                           | 用途与约束                                                                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| STAFF_MFA_REQUIRED             | 默认false，仅非生产开发可不强制；私有验收配置true。production无论该值如何均强制工作人员当前会话MFA，不是生产绕过开关。                    |
| MFA_TEST_DATABASE_URL          | 仅独立本机zhongyuan_daojia_test的HTTP/DB自测；私有服务器仅专用zydj_acceptance_smoke且CONFIRM_PRIVATE_ACCEPTANCE_TEST=true；禁止生产目标。 |
| MFA_RECOVERY_TEST_DATABASE_URL | 受审恢复专项HTTP/DB自测；允许目标与MFA_TEST_DATABASE_URL相同，脚本拒绝普通远程库和生产库。                                                |

MFA密钥沿用DATA_ENCRYPTION_KEY_BASE64加密，禁止更换该主密钥而不做受审迁移。没有默认验证器密钥、通用恢复码、关闭MFA或重置快捷变量；受审恢复也没有生产开关或复核绕过变量。详见[MFA交付](STAFF_MFA_IMPLEMENTATION.md)和[恢复交付](MFA_RECOVERY_IMPLEMENTATION.md)。
