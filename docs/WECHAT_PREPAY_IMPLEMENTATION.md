# 微信JSAPI预下单交付与验收边界

日期：2026-10-04。开发基线main e8129c5；没有改动现有服务器或使用真实资金。

## 实现顺序

1. `POST /v1/orders/:id/payment-intent` 在wechat模式路由到WechatPrepayService；订单归属校验、`WECHAT_PAY_PREPAY_ENABLED=true`、真实微信身份、HTTPS回调是必要条件。仅填写商户材料或更改provider不会开启资金请求。
2. openid仅从当前用户的加密ExternalIdentity解密，并核对当前AppID对应的身份HMAC；拒绝Mock身份、错误AppID或缺失/损坏身份。客户端不能提交金额、openid、商户号或预支付标识。
3. 锁Order后检查待支付/预约HOLD与期限；整数分及商品描述来自服务器订单快照。剩余时间不足90秒不创建新预下单，避免微信将过短期限自动延长到一分钟。time_expire按服务器期限以RFC3339整秒发送。
4. 同事务创建唯一Payment及DISPATCHING/prepayRequestedAt、事件与审计，提交后才调用微信POST。并发请求复用原Payment；网络请求不在数据库事务中。
5. POST路径与实际JSON字节参加商户RSA签名；响应原始字节先验证微信签名再取prepay_id。READY保存标识及时间，返回四行签名的RSA参数供wx.requestPayment使用。再次调用只重签SDK参数，不重新POST。
6. 超时、无效响应/签名或进程崩溃保留UNKNOWN/DISPATCHING原单，绝不自动重新POST或生成新业务号。旧记录NONE也不能视为“未发起”，只查原单/人工核实；无SDK参数的小程序入口会尝试客户本人查单。
7. SDK成功不是到账证据。小程序调用服务端reconcile并刷新，订单只由已有验签通知/查单事务确认。SDK取消不调用本地取消、不释放预约；失败也不调用Mock成功接口。

## 数据库与预约防护

应用迁移 `20261004014500_wechat_prepay`，总链为12批。新增状态、派发/就绪时间和独立错误码，不覆盖支付成功/退款状态。DB CHECK禁止非微信派发及无标识/时间的READY。

取消使用与预下单相同的Order行锁，微信PENDING原单不能本地取消释放。预约列表继续屏蔽已过期但仍有待查微信支付的HOLD；新预约的过期清理也排除这些占位。Mock/无支付的正常超时规则保持不变。

## 本轮实际验证

- 单元测试覆盖服务端金额/期限/身份、关闭开关无写入、并发一POST、READY复用、UNKNOWN/崩溃/遗留记录不重发、请求过程订单变化不返回SDK参数、RSA原始POST/调起签名及响应篡改。
- 独立PostgreSQL八并发只有一记录/一渠道替身调用；超时不重发；READY约束生效；未确认的取消不释放HOLD；通知/查单仍为最终支付依据。
- 全流程HTTP及编译小程序JS验证Mock链路未回归；SDK成功/取消/失败/UNKNOWN使用本地替身，不能冒充真机资金验收。
- GitHub CI增加预下单/支付/退款数据库验证；远程通过与否查看最终commit对应工作流。

## 尚未解除的发布阻断

两个资金开关初始均false。未执行真实code/商户绑定/预下单/真机支付/到账/退款/真实账单验收。微信自动查询、渠道关闭、关闭后确认和异常修正尚未实现；当前待查原单需要指定财务人员核实，不可直接改库或另建支付号。后台正式登录/MFA、履约、消息/地图/安全处置、outbox消费/告警等仍见部署门禁。

下一开发顺序：先完成微信原单查询/渠道关闭/再次核实的幂等补偿，再完善生产后台认证与履约；完成全部阻断项后才能申请受控真机资金验收与发布。

## 官方规则

- [JSAPI/小程序下单：整数分、openid、支付期限及响应prepay_id](https://pay.wechatpay.cn/doc/v3/merchant/4012791897)
- [JSAPI调起支付RSA签名：AppID、时间戳、随机串、package四行换行](https://pay.wechatpay.cn/doc/v3/merchant/4012365339)
