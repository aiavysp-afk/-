# 退款闭环实现（2026-10-04）

## 规则与额度

全链路使用整数分/BigInt。`可退余额 = 实付金额 − 成功退款金额 − 未结束申请占用金额`。客户端不能指定退款金额、状态、复核人或申请人。当前批准的技术规则版本为 `2026-10-03.dev-pre-service-full-v1`：服务开始前、已付款订单可对剩余额度全退；已记录FULFILLMENT_REVIEW_REQUIRED的取消订单可走迟到支付退款。服务中/完成/争议/部分退款不自动套用该规则，需另行批准业务策略；它不是法律意见或正式经营退款承诺。

REQUESTED立即占额度，但不提前标资金已退款；批准时再次检查订单履约状态/额度/策略版本，变更订单与支付为REFUNDING并释放占位。若履约在待审时进入服务，批准失败，可拒绝释放额度。REJECTED释放额度，不改变原付款/履约结果。

| 状态       | 含义                            | 额度                       |
| ---------- | ------------------------------- | -------------------------- |
| REQUESTED  | 已申请待独立复核                | 保留                       |
| APPROVED   | 已复核待提交                    | 保留                       |
| PROCESSING | 已持久化提交标记/渠道处理中     | 保留                       |
| UNKNOWN    | 网络或验证结果不确定            | 保留，只查原单             |
| ABNORMAL   | 微信异常结果                    | 保留，查询/人工处理        |
| CLOSED     | 微信关闭结果                    | 保留，人工核实；不自动重发 |
| SUCCEEDED  | 验签且金额/原支付流水匹配的成功 | 占用转成功已退             |
| REJECTED   | 独立复核拒绝                    | 释放                       |

## 申请复核分离与接口

客户自己的订单可POST `/v1/orders/:orderId/refunds`（空对象+Idempotency-Key），金额/原因由服务端判定。GET同路径查看自己的状态。不能申请/查看别人订单。

组织财务：

- GET `/v1/admin/organizations/:organizationId/payments`：最近50笔支付/订单编号/预算，限定finance.request或finance.approve权限，不返回地址/微信身份/凭据。
- GET/POST `.../payments/:paymentId/refunds`：列表含独立复核身份/事件；申请需要finance.request；Body只有reason，拒绝额外金额字段。
- POST `.../refunds/:id/approve` / `reject`：finance.approve，结论code受严格枚举校验；即使ADMIN或兼具两种角色，也不能复核自己的申请。
- POST `.../refunds/:id/submit`：finance.approve、申请人不能自行提交。真实渠道默认503开关关闭；Mock提交只进入PROCESSING。
- POST `.../refunds/:id/reconcile`：finance.approve，仅查询既有已提交微信退款单，绝不发起第二次POST。
- POST `/v1/dev/organizations/:organizationId/refunds/:id/succeed`：只有非production且mock模式允许，仍要求独立财务复核身份。
- POST `/v1/payments/wechat/refund-notify`：原始字节RSA验签、5分钟时间戳、公钥ID/证书检查、AES-GCM解密，校验商户/退款号/原支付号与流水/金额/状态。成功空204，失败不误应答成功。

不存在通用“改退款状态/金额”接口。页面按钮禁用只是体验，所有权限均在服务端校验。生产管理端正式认证/MFA仍为上线阻断项。

## 并发、原子性和恢复

支付与退款统一先锁Order行再读当前Payment/Refund；额度计算、退款记录、预算增减、订单状态、RefundEvent、OrderEvent、AuditLog与Outbox在同一事务。支付ID+幂等键唯一；同键相同申请返回原记录，同键不同身份/原因409；另一个申请抢同一余额409。

真实退款提交在网络前持久化原业务号/PROCESSING/submittedAt/下次查询时间，只有成功获取提交资格的请求会发POST。并发提交返回原记录。POST成功不代表退款成功，仍按验签结果处理；超时或失败不释放预算、不创建新号，只转UNKNOWN并查询原号。崩溃在POST前也可能留下未受理的原号，该情形保守升级人工核实，而不自动补发可能重复交易。

自动恢复每分钟扫描最多10笔PROCESSING/UNKNOWN/ABNORMAL；数据库updateMany精确匹配旧attempt/status和到期时间领取租约，多实例只一人查询。退避2分钟至1小时，最多12次，未解决写人工处理Outbox。CLOSED不自动轮询，但财务可查原单。当前没有自动解冻已提交异常退款或重新提交接口，不能通过手改库/另建单绕过；必要修正须形成新的受审开发与审计流程。

只有渠道SUCCESS（或明确的本地mock测试）才将占用转已退并插入唯一退款记账。成功后的重复通知、晚到CLOSED/PROCESSING不回退，不二次记账。退款状态事件不包含收款人账户、openid、密文或密钥。

数据库CHECK保证非负、已退+占用不超实付、申请人!=复核人、成功时间必填；延迟约束触发器在事务最终状态校验预算等于退款记录求和、成功退款存在且仅存在同额posting。Posting唯一且禁止UPDATE。该单行posting表达等额借贷两腿，仅覆盖退款出款记账，不是完整企业总账/冲正体系；退款全量删除没有应用接口，备份/审计保留仍需运维权限制度。

## 对账与发布边界

日交易账单增加退款金额、原支付号、微信退款流水、缺失本地/渠道记录与需查原单差异；跨日按退款业务号关联，不据账单推断到账。代码不自动消除差异。真实账单表头/手续费/到账口径仍需实际商户验收。

本地HTTP、签名协议与真实PostgreSQL并发测试通过，不代表微信真机资金验收。真实预下单保持禁用；真实退款开关默认false；不修改现有生产服务器服务。

官方依据：[退款申请](https://pay.wechatpay.cn/doc/v3/merchant/4012791903)、[退款查单](https://pay.wechatpay.cn/doc/v3/merchant/4012791904)、[退款通知](https://pay.wechatpay.cn/doc/v3/merchant/4012791906)。
