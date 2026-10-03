# 微信原单查单、关单与再次核实

日期：2026-10-04；基线main `66caa59`。仅使用合成测试和签名渠道替身，不证明真实微信资金验收通过。

## 实现

- 独立`WECHAT_PAY_RECOVERY_ENABLED=false`门禁。provider、预下单和退款开关均不自动开启补偿。未启用不扫描、不关单；客户普通查单仍是已有只读入口。
- `POST /v1/payments/orders/:id/close`需要客户本人会话。无支付/Mock沿用原取消事务；微信先锁Order持久化关闭申请，再执行原单恢复。返回order/pendingConfirmation/reviewRequired，前端不直接标取消。旧`/orders/:id/cancel`仍拒绝未核实的微信支付。
- 自动工作器每60秒扫描至多10笔微信PENDING原单；持久化120秒租约/随机owner和1/2/4/8分钟至1小时退避。所有关闭和到账状态事务先锁Order。最多12次；最后一次派发后崩溃也在租约过期后转人工，审计/outbox只写一次。
- 查单验签，核对当前AppID/商户、原商户单号、JSAPI类型以及提供的金额。未支付/关闭响应允许官方选填amount缺失；SUCCESS仍必须有完整整数分/CNY、流水和支付时间。金额不能从客户端提供。
- SUCCESS走已有到账事务，绝不发关单；超期到账进入履约核查，不恢复失效预约。NOTPAY只有持久化客户取消/超时意图才允许关单。USERPAYING、REFUND、REVOKED、PAYERROR、ACCEPTED、订单不存在、验签失败或网络异常均不能授权释放预约。
- 关单POST签名准确路径与mchid JSON，验签空204；204只是确认收到，不是释放依据。成功、超时或错误后均再次查原单；只有验签CLOSED才同事务将支付CLOSED、订单CANCELLED、HOLD释放/过期，并记录事件/审计/outbox。回调成功优先于迟到CLOSED结果。
- 不发新预下单或退款、不换业务号。关单不涉及扣款，可在退避后“再次查到NOTPAY”时幂等重试**同一个原单**，最多12次。租约过期的旧请求不能覆盖新owner或到账结果。
- 已申请关闭不再返回可用SDK参数。SDK取消也查询支付结果，但不等于申请取消订单。Mock超时扫描在Order锁后重新核对支付，防止初次扫描与真实预下单并发导致误释放。

## 数据库与验证

新增第13批migration `20261004022000_wechat_recovery`：关单状态、申请/派发/核实时间、次数、渠道事实、恢复租约、退避与人工核查时间。CHECK限制次数0–12、lease成对、微信关闭意图及CONFIRMED证据。没有修改已应用的旧migration。

本地单元测试、真实Nest HTTP、编译小程序JS和独立PostgreSQL验证：双实例一租约/一POST；204未核实不释放；超时原单再查；到账回调赢过关单；确认关闭后迟到款留痕；最终lease崩溃只升级一次；DB拒绝非法计数/lease；默认门禁、越权及Mock取消回归。签名测试使用临时密钥，不调用真实微信接口。

## 发布与人工处置

三个开关均默认false。隔离验收可单独开启补偿，但必须先绑定正确商户、订单号范围与异常责任人；不对原服务器其他商城订单扫描。生产管理员/MFA、outbox消费/告警、正式履约、短信/地图/安全值班及真实资金/账单仍未验收，阻止公网经营上线。

人工核查查看PaymentEvent、OrderEvent、AuditLog和原商户单号。`recoveryReviewAt`非空不再自动重试；不能直接改库、重置次数、释放HOLD或另建资金单。人工修正/授权恢复流程及正式值班界面须后续开发并审查。

## 官方依据

- [小程序商户订单号查询：未支付/关闭字段和状态](https://pay.wechatpay.cn/doc/v3/merchant/4012791900)
- [关闭订单：原商户单号、mchid、无包体204和同参数重试](https://pay.wechatpay.cn/doc/v3/merchant/4012791901)
- [小程序开发指引：SDK返回后查单，NOTPAY不能视为支付失败](https://pay.wechatpay.cn/doc/v3/merchant/4012791911)
