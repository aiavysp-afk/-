# 短信、地图、企业微信客服与紧急值班入口

2026-10-04：本轮实现渠道基础适配器、生产凭据门禁、小程序企业微信客服与商家紧急拨号、H5紧急拨号。用户已确认短信签名/模板审核通过和腾讯地图企业账号，并选择企业微信客服及单独的紧急值班手机号。账号存在不代表已配置完整凭据或已完成真人验收。

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
| SAFETY_CONTACT_MODE                                     | phone或wecom；本轮用户选择wecom                                     |
| SAFETY_EMERGENCY_PHONE                                  | 商家独立紧急值班手机号，只在受控配置填写                            |
| SAFETY_DUTY_CONFIRMED                                   | 默认false，不替代当前在线/接听状态检测                              |
| SAFETY_HOTLINE                                          | 旧电话模式兼容变量；wecom模式不需要把客服URL塞进此字段              |

## 当前服务器与待验收项

生产 pending 和私有验收配置已分别受控备份，保留原密码、pepper、加密密钥与三个微信资金开关false；只新增客服选择、用户指定紧急号码和关闭的渠道开关。生产 pending 仍不启用公开服务。旧系统签名和模板字段存在，完整访问凭据及腾讯Key/SK未找到。

还需要企业微信后台生成的**实际客服链接和CorpID**（不是示例占位值），及小程序客服绑定/认证核验；短信RAM凭据、模板用途和腾讯地图Key/SK需通过服务器安全配置提供，不发到聊天。值班确认位仍false。公网继续维护503；生产库16批迁移不变、不导入旧数据。

短信尚未接订单Outbox：必须先建立持久化派发记录、并发租约、手机号/日预算/频率控制、敏感数据保护、回执查验及UNKNOWN人工处置，才能调用内部submit。OutId只是关联字段，不能当作阿里云幂等键。地图尚未接预约页面/服务区校验：需登录与持久化限流、地址确认和隐私授权。客服目前只是用户主动入口，不是自动应急告警/接单/超时升级闭环。这些仍阻止公开经营。

## 测试与官方协议依据

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
