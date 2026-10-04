# 微信JSAPI预下单交付与验收边界

## 最新小程序支付确认修正（2026-10-04）

完整商城订单页此前固定显示“模拟支付（不会扣款）”，但WECHAT分支能调起真实微信支付。现改为中性“查看支付渠道并确认”，只依据服务器返回的实际支付意图分流，不能用开发模式或公开provider标签承诺不会扣款或已经开放资金功能。

- 只有当前已加载的PENDING_PAYMENT订单可发起支付准备；意图安全ID、所属订单、正安全整数分与显示订单金额必须一致，否则停止。当前支付入口不处理0元订单；不得用Mock成功接口代替未定义的0元履约规则。
- WECHAT必须PENDING/READY且有SDK参数；UNKNOWN、DISPATCHING、NONE、缺状态/参数等只查原支付并刷新，不创建第二笔。READY分支先显示“确认微信真实支付”和服务端金额，明确真实付款及微信最终确认；用户取消/弹窗失败不调用SDK，不自动取消订单或释放预约。支付意图在该确认前已经准备，取消提示不能被理解为撤销预下单。
- MOCK只在精确provider、PENDING状态、mockConfirmationAvailable===true及显式弹窗确认时调用开发成功接口；字符串/数字等真假值、未知provider均拒绝，绝不让未知渠道落入模拟成功。
- SDK成功/取消/失败仍查原单，最终状态只取服务器。没有新增本地“PAID”或到账承诺，没有开启真实资金开关。

本机5工作区typecheck、pnpm test（API302+合约13+H5拨号3项）和pnpm build通过，官方wcc全部8页exit 0；新增19项支付编译页面VM替身测试，连同4项WXML和5项客服测试共28项通过，另13项联系渠道包边界回归通过。隔离本机PostgreSQL测试库仍16批迁移，商城HTTP流程验证登录/目录/占位/报价/下单/Mock支付/订单/退款/额度/异人复核/幂等与微信SDK替身链路通过，测试自报合成记录已清理。CI已加入支付页面测试；不使用这些结果替代微信真机、商户绑定、实际收款或退款到账验收。

改动文件：orders/index.ts、生成JS、WXML；scripts/verify-miniapp-payment.test.mjs；商城HTTP测试只新增虚拟微信订单加载以满足可见订单保护；CI工作流及本记录/SELF_TEST_REPORT/IMPLEMENTATION_STATUS/CHANGE_FILES。没有新增环境变量或数据库迁移，没有服务器切换、正式上传或真实资金调用；联系渠道专项包不含此商城支付代码，企业客服人工验收仍独立待确认。

日期：2026-10-04。开发基线main e8129c5；没有改动现有服务器或使用真实资金。

## 实现顺序

1. `POST /v1/orders/:id/payment-intent` 在wechat模式路由到WechatPrepayService；订单归属校验、`WECHAT_PAY_PREPAY_ENABLED=true`、真实微信身份、HTTPS回调是必要条件。仅填写商户材料或更改provider不会开启资金请求。
2. openid仅从当前用户的加密ExternalIdentity解密，并核对当前AppID对应的身份HMAC；拒绝Mock身份、错误AppID或缺失/损坏身份。客户端不能提交金额、openid、商户号或预支付标识。
3. 锁Order后检查待支付/预约HOLD与期限；整数分及商品描述来自服务器订单快照。剩余时间不足90秒不创建新预下单，避免微信将过短期限自动延长到一分钟。time_expire按服务器期限以RFC3339整秒发送。
4. 同事务创建唯一Payment及DISPATCHING/prepayRequestedAt、事件与审计，提交后才调用微信POST。并发请求复用原Payment；网络请求不在数据库事务中。
5. POST路径与实际JSON字节参加商户RSA签名；响应原始字节先验证微信签名再取prepay_id，并拒绝超过官方64字符上限的标识。READY保存标识及时间，返回四行签名的RSA参数供wx.requestPayment使用。再次调用只重签SDK参数，不重新POST。
6. 超时、无效响应/签名或进程崩溃保留UNKNOWN/DISPATCHING原单，绝不自动重新POST或生成新业务号。旧记录NONE也不能视为“未发起”，只查原单/人工核实；无SDK参数的小程序入口会尝试客户本人查单。
7. SDK成功不是到账证据。小程序调用服务端reconcile并刷新，订单只由已有验签通知/查单事务确认。SDK取消不调用本地取消、不释放预约；失败也不调用Mock成功接口。

## 数据库与预约防护

预下单采用第12批迁移 `20261004014500_wechat_prepay`；后续[原单补偿](WECHAT_RECOVERY_IMPLEMENTATION.md)加入第13批，总链13批。新增状态、派发/就绪时间和独立错误码，不覆盖支付成功/退款状态。DB CHECK禁止非微信派发及无标识/时间的READY。

取消使用与预下单相同的Order行锁，微信PENDING原单不能本地取消释放。预约列表继续屏蔽已过期但仍有待查微信支付的HOLD；新预约的过期清理也排除这些占位。Mock/无支付的正常超时规则保持不变。

## 本轮实际验证

- 单元测试覆盖服务端金额/期限/身份、关闭开关无写入、并发一POST、READY复用、UNKNOWN/崩溃/遗留记录不重发、请求过程订单变化不返回SDK参数、RSA原始POST/调起签名及响应篡改。
- 独立PostgreSQL八并发只有一记录/一渠道替身调用；超时不重发；READY约束生效；未确认的取消不释放HOLD；通知/查单仍为最终支付依据。
- 全流程HTTP及编译小程序JS验证Mock链路未回归；SDK成功/取消/失败/UNKNOWN使用本地替身，不能冒充真机资金验收。
- GitHub CI增加预下单/支付/退款数据库验证；远程通过与否查看最终commit对应工作流。

## 尚未解除的发布阻断

三个开关初始均false。未执行真实code/商户绑定/预下单/真机支付/到账/退款/真实账单验收。微信自动查询、渠道关闭和关闭后确认已实现并通过本地替身/数据库验证；自动恢复最多12次，人工修正/授权恢复尚未实现，不可直接改库或另建支付号。后台正式登录/MFA、履约、消息/地图/安全处置、outbox消费/告警等仍见部署门禁。

下一开发顺序：独立服务器验收环境与部署核对，然后完善生产后台认证/MFA、人工异常处置与履约；完成全部阻断项后才能申请受控真机资金验收与发布。

## 官方规则

- [JSAPI/小程序下单：整数分、openid、支付期限及响应prepay_id](https://pay.wechatpay.cn/doc/v3/merchant/4012791897)
- [JSAPI调起支付RSA签名：AppID、时间戳、随机串、package四行换行](https://pay.wechatpay.cn/doc/v3/merchant/4012365339)
