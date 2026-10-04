# 短信、地图、企业微信客服与紧急值班入口

2026-10-04：本轮实现渠道基础适配器、生产凭据门禁、小程序企业微信客服与商家紧急拨号、H5紧急拨号。用户已确认短信签名/模板审核通过和腾讯地图企业账号，并选择企业微信客服及单独的紧急值班手机号。账号存在不代表已配置完整凭据或已完成真人验收。

## 最新客服归属确认增量（优先于下文历史回执）

原服务器两份环境文件的WECHAT_KF_URL及20260910企业微信部署脚本保存了同一官方客服链接；旧CorpID为空，两份旧源码归档107个文本项也没有企业ID记录。官方链接HTTP200但页面不公开企业ID，因此这些检查只能证明旧配置存在、格式正确和网页可访问，不能独立证明归属/绑定/真人接通。

用户本轮明确确认该客服链接属于已提供CorpID、客服账号仍有效且已绑定当前小程序。新增 `WECOM_CUSTOMER_SERVICE_CONFIRMED`（默认false）：只有受控记录这一人工核验后，合法链接/CorpID才能作为可打开的客服入口发布；生产选用企业微信时也必须通过此门禁。不能用“继续下一步”、链接HTTP200或值班确认替代归属核验。

后续按此确认将旧WECHAT_KF_URL映射至新版WECOM_CUSTOMER_SERVICE_URL，两套受控配置单独备份、保留其他秘密和权限。客服确认只代表用户核验归属/账号/绑定，**不等于真人真机接通、客服在线或紧急求助受理**；SAFETY_DUTY_CONFIRMED保持false。小程序未开放时显示“未就绪”，配置确认不绕过微信SDK失败提示。

本机5工作区typecheck/build通过，API302+合约13+H5拨号3=318项测试及5项编译小程序客服/拨号替身测试通过。新增两项客服独立确认测试，覆盖未设/false时合法标识不可用、值班确认不能绕过、生产电话安全模式+企微客服同样必须确认；现有确认后入口和恶意URL检查继续通过。

本增量文件：`.env.example`；API `config/env.ts`、`env.test.ts`、`public/customer-service.config.ts`、其测试和`public.controller.ts`；小程序`utils/customer-service.ts/js`、`pages/profile/index.wxml`；`scripts/verify-customer-service.test.mjs`；本记录及ENV_VARIABLES/INTEGRATION_GATES/SELF_TEST_REPORT/IMPLEMENTATION_STATUS/DEPLOYMENT。无新增迁移、密钥或真实交易。

上线前仍须两台微信真机分别打开正确客服账号并验证接通/失败回退、客服主备值班和升级流程；保留紧急电话测试与独立值班确认。短信、地图、资金与真实经营门禁不因本项解除。

## 已实现边界

- 阿里云 SMS：固定 HTTPS 中国站 SendSms，ACS3-HMAC-SHA256、随机 nonce、可选 STS；单收件人、固定配置模板/签名、模板变量校验。8秒超时、禁止跳转、64KiB流式响应上限、失败诊断不带手机号/密钥。返回 ACCEPTED/REJECTED/UNKNOWN，ACCEPTED只表示渠道受理，不表示送达。超时/异常不自动重发。
- 腾讯地图：服务端 SK 签名，地址解析及用户给出的 suggestion 地址提示，固定 HTTPS 域名、同城 region_fix=1/上门服务 policy=1、限10条建议，只返回普通POI和GCJ-02坐标；低精度标记人工确认，不能直接作为服务范围判断。签名使用原始排序参数，传输单独URL编码。无JSONP、无前端SK、无任意URL代理。
- 两个适配器注册到 Nest 模块，但**没有开放发送/地图HTTP代理或启动自动发送任务**。真实调用开关 SMS_SEND_ENABLED/MAP_GEOCODING_ENABLED 默认 false；provider 改成 aliyun/tencent 时生产还必须通过完整凭据检查。
- 企业微信客服：严格校验 work.weixin.qq.com 的 kfid/kf 路径与 CorpID；公开配置仅返回公开标识，不需要企业微信 API secret/token。小程序“我的”页预加载配置，用户点击时同步调用 wx.openCustomerServiceChat，保留用户手势；未配置、客户端不支持和原生接口失败均明确提示，不声明客服在线或求助受理。
- 紧急值班电话：用户提供的号码只写服务器受控配置，不硬编码到代码、示例或文档。小程序使用 wx.makePhoneCall；H5替换无响应的SOS按钮为商家紧急值班拨号，tel URI仅接受大陆手机格式。拨号入口不自动报案、不记录“已受理”，也不是当地应急机关入口。没有实际拨号测试。
- 客服和安全值班分离：SAFETY_CONTACT_MODE=wecom 时必须有有效客服公开标识、单独紧急电话及 SAFETY_DUTY_CONFIRMED=true 才能过生产门禁。确认位默认 false，只能在值班主备岗、响应/升级流程、无法接通兜底和真人演练完成后由负责人确认，不能为了启动而随意修改。

## 环境变量

| 变量                                                    | 要求                                                                |
| ------------------------------------------------------- | ------------------------------------------------------------------- |
| ALIYUN_SMS_ACCESS_KEY_ID / ALIYUN_SMS_ACCESS_KEY_SECRET | 专用RAM最小权限凭据，服务器注入                                     |
| ALIYUN_SMS_SECURITY_TOKEN                               | 可选STS临时token，需受控刷新                                        |
| ALIYUN_SMS_SIGN_NAME / ALIYUN_SMS_TEMPLATE_CODE         | 审核通过且用途与业务事件匹配；旧模板用途未核验，不自动沿用          |
| SMS_SEND_ENABLED                                        | false；持久化派发/额度/送达回执验收后才允许启用                     |
| TENCENT_MAP_KEY / TENCENT_MAP_SIGNING_SECRET            | WebService专用Key和SN校验SK，服务器注入                             |
| MAP_GEOCODING_ENABLED                                   | false；服务城市/隐私授权、限流/配额和真实渠道验收后启用             |
| CUSTOMER_SERVICE_PROVIDER                               | none 或 wecom                                                       |
| WECOM_CORP_ID                                           | 企业ID公开标识，不是企业secret                                      |
| WECOM_CUSTOMER_SERVICE_URL                              | 企业微信后台生成的官方客服链接；允许enc_scene，不接受token/跳转参数 |
| WECOM_CUSTOMER_SERVICE_CONFIRMED                        | 默认false；负责人核验同企业归属、有效账号与小程序绑定后受控确认；不是在线/接通标志 |
| SAFETY_CONTACT_MODE                                     | phone或wecom；本轮用户选择wecom                                     |
| SAFETY_EMERGENCY_PHONE                                  | 商家独立紧急值班手机号，只在受控配置填写                            |
| SAFETY_DUTY_CONFIRMED                                   | 默认false，不替代当前在线/接听状态检测                              |
| SAFETY_HOTLINE                                          | 旧电话模式兼容变量；wecom模式不需要把客服URL塞进此字段              |

## 当前服务器与待验收项

生产 pending 和私有验收配置已分别受控备份，保留原密码、pepper、加密密钥与三个微信资金开关false；只新增客服选择、用户指定紧急号码和关闭的渠道开关。生产 pending 仍不启用公开服务。旧系统签名和模板字段存在，完整访问凭据及腾讯Key/SK未找到。

用户随后提供的企业微信CorpID已写入生产pending和私有验收受控配置，格式门禁通过。还需要后台生成的**实际客服链接**及小程序客服绑定/认证核验；短信RAM凭据、模板用途和腾讯地图Key/SK需通过服务器安全配置提供，不发到聊天。值班确认位仍false。公网继续维护503；生产库16批迁移不变、不导入旧数据。

短信尚未接订单Outbox：必须先建立持久化派发记录、并发租约、手机号/日预算/频率控制、敏感数据保护、回执查验及UNKNOWN人工处置，才能调用内部submit。OutId只是关联字段，不能当作阿里云幂等键。地图尚未接预约页面/服务区校验：需登录与持久化限流、地址确认和隐私授权。客服目前只是用户主动入口，不是自动应急告警/接单/超时升级闭环。这些仍阻止公开经营。

## 测试与官方协议依据

### 已执行的私有部署回执（2026-10-04）

- 代码提交 `087fbdf7c98edbad382db7232fb53fee2136a52c` 已推送 GitHub main，[CI run 37183031942](https://github.com/aiavysp-afk/-/actions/runs/37183031942) success，包含所有工作区类型检查/测试/构建、编译小程序客服测试以及五套HTTP/PostgreSQL流程。
- 服务器 current 已切换至同一代码提交；发布归档SHA256为 `1054ef463e454e4e2b27fd7524a0bbf0bdd0fc5bce28daa33ac127376d4a180d`，部署前备份独立验收库，16批迁移无新增待执行项。保留上一版以便回滚，不清理密钥或备份。
- 三个私有服务active，仅监听127.0.0.1:3210/3212/3213；通过API及两套同源代理核验公开配置中的紧急号码与受控配置一致，客服available=false、值班确认false，未填写的客服标识不下发。
- 服务器商城/支付数据库/MFA/浏览器登录交接/MFA恢复五套真实HTTP/PostgreSQL隔离流程、6项预览安全测试、5项编译小程序客服/拨号替身测试全部通过。验收、smoke及独立生产库均16批迁移，User/Order/BrowserLoginChallenge/BrowserLoginRateLimit/MfaRecoveryRequest均零行。
- 首次部署受控验收配置与发布前快照逐字节一致（640 root:zydj-acceptance）；生产pending仍600 root:root。随后先备份两份配置，再仅修改用户提供的CorpID，原秘密和权限全部保持不变，重启私有API并复查三个端点。生产最新拒绝启动的四项为SMS_PROVIDER、MAP_PROVIDER、WECOM_CUSTOMER_SERVICE_URL、SAFETY_DUTY_CONFIRMED；五个真实渠道/资金开关false。已配置CorpID但缺URL时，公开配置仍返回不可用且不下发半成品标识。
- nginx -t通过，mtsc.top/api.mtsc.top/admin.mtsc.top HTTPS均503，三个旧服务/定时器disabled/inactive，磁盘约35GiB可用。没有解除公网维护。
- 浏览器实际读取私有技师H5，紧急值班按钮的可访问名称为“拨打商家紧急值班电话”，截图核验显示正常；页面仍明确标记开发演示数据。没有点击真实拨号，客服原生微信操作仍需真机验收。

### 上线前人工核对

1. 提供实际企业微信官方客服链接；CorpID已受控配置。核验企业/小程序主体、认证、绑定及两台微信真机入口，不提供企业secret到聊天。
2. 负责人确认紧急号码归属及可公开展示，测试营业期间主备值班、无法接通兜底和升级流程。电话只是商家值班，不能替代当地公共应急号码；演练成功后才可设置值班确认。
3. 短信凭据、签名和模板用途及地图Key/SK只从服务器受控配置注入，先补齐持久化派发/配额/限流/隐私授权，再做真实渠道受控验收。
4. 两名不同自然人完成管理员MFA和退款申请/异人复核演练；核验商户主体、回调域名及真实支付/退款/对账后，按各自门禁分别启用资金操作。
5. 确认技师H5真实经营功能、服务区/服务规则、经营资质、隐私与退款条款和安全响应闭环；按DEPLOYMENT中的备份、回滚和发布顺序签字，不能直接重命名pending绕过门禁。

本机5工作区typecheck和build通过；API300项、合约13项、H5拨号3项通过；编译小程序客服/拨号替身5项通过。新增28项渠道签名/门禁/解析/异常测试、12项客服配置与恶意链接测试、3项环境门禁测试。所有外部请求均用替身，未发送短信、查询真实地图、打开真实客服或拨打用户电话。真机扫码/微信原生API与接听演练仍必须人工完成。

- [阿里云ACS3签名规范及官方测试向量](https://www.alibabacloud.com/help/en/sdk/product-overview/v3-request-structure-and-signature)
- [SendSms参数、受理与无幂等提醒](https://help.aliyun.com/zh/sms/developer-reference/api-dysmsapi-2017-05-25-sendsms)
- [腾讯地图服务端签名与URL编码](https://lbs.qq.com/faq/serverFaq/webServiceKey)
- [腾讯官方地址解析协议参考](https://github.com/TencentLBS/tencentmap-webservice-skill/blob/main/references/api-geocoder.md)
- [腾讯官方地址提示协议参考](https://github.com/TencentLBS/tencentmap-webservice-skill/blob/main/references/api-search.md)
- [微信原生客服API](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/service-chat/wx.openCustomerServiceChat.html)和[企微生成客服链接](https://developer.work.weixin.qq.com/document/path/94665)：本轮官方页面读取受限，代码仅做替身/结构验收，不能宣称真实官方接入已通过。

## 改动文件

- `.env.example`、`.github/workflows/ci.yml`
- `apps/api/src/app.module.ts`、`apps/api/src/config/env.ts`、`env.test.ts`
- `apps/api/src/integrations/`：签名、SMS/地图适配器、响应边界、模块和测试
- `apps/api/src/public/public.controller.ts`、`customer-service.config.ts`、`customer-service.config.test.ts`
- `packages/contracts/src/index.ts`
- `apps/miniapp/types/global.d.ts`、`utils/customer-service.ts`和生成JS
- `apps/miniapp/pages/profile/index.ts`、生成JS、WXML
- `apps/workbench-h5/src/main.tsx`、`support.ts`、`support.test.ts`
- `scripts/verify-customer-service.test.mjs`
- 本文、README、CHANGE_FILES、DEPLOYMENT、ENV_VARIABLES、IMPLEMENTATION_STATUS、INTEGRATION_GATES、SELF_TEST_REPORT中的最新状态说明

没有新增数据库迁移，没有提交手机号或服务器密钥/备份。

代码提交完整33文件清单（后续仅增加验收文档记录）：

```text
.env.example
.github/workflows/ci.yml
README.md
apps/api/src/app.module.ts
apps/api/src/config/env.test.ts
apps/api/src/config/env.ts
apps/api/src/integrations/aliyun-signature.ts
apps/api/src/integrations/aliyun-sms.client.ts
apps/api/src/integrations/integration-http.ts
apps/api/src/integrations/integrations.module.ts
apps/api/src/integrations/integrations.test.ts
apps/api/src/integrations/tencent-map.client.ts
apps/api/src/public/customer-service.config.test.ts
apps/api/src/public/customer-service.config.ts
apps/api/src/public/public.controller.ts
apps/miniapp/pages/profile/index.js
apps/miniapp/pages/profile/index.ts
apps/miniapp/pages/profile/index.wxml
apps/miniapp/types/global.d.ts
apps/miniapp/utils/customer-service.js
apps/miniapp/utils/customer-service.ts
apps/workbench-h5/src/main.tsx
apps/workbench-h5/src/support.test.ts
apps/workbench-h5/src/support.ts
docs/CHANGE_FILES.md
docs/DEPLOYMENT.md
docs/ENV_VARIABLES.md
docs/IMPLEMENTATION_STATUS.md
docs/INTEGRATION_GATES.md
docs/SELF_TEST_REPORT.md
docs/SUPPORT_CHANNELS_IMPLEMENTATION.md
packages/contracts/src/index.ts
scripts/verify-customer-service.test.mjs
```

部署回执另更新 `docs/DEPLOYMENT_ACCEPTANCE_20261004.md`，其他回执文档均已在上述清单中。本轮所有代码、文档均直接提交main；服务器只部署上述代码提交，后续文档提交不改变运行代码。
