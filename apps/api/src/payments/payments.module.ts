import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { OrdersModule } from "../orders/orders.module.js";
import { PaymentExpiryWorker } from "./payment-expiry.worker.js";
import { PaymentGatewayService } from "./payment-gateway.service.js";
import { PaymentsController } from "./payments.controller.js";
import { PaymentsService } from "./payments.service.js";
import { WechatPayClient } from "./wechat-pay.client.js";
import { WechatPaymentsController } from "./wechat-payments.controller.js";
import { WechatPaymentsService } from "./wechat-payments.service.js";
import { PaymentReconciliationController } from "./payment-reconciliation.controller.js";
import { PaymentReconciliationService } from "./payment-reconciliation.service.js";
import { RefundsController } from "./refunds.controller.js";
import { RefundsService } from "./refunds.service.js";
import { RefundReconciliationWorker } from "./refund-reconciliation.worker.js";
import { WechatPrepayService } from "./wechat-prepay.service.js";
import { WechatRecoveryService } from "./wechat-recovery.service.js";
import { WechatRecoveryWorker } from "./wechat-recovery.worker.js";
import { StoredValueRechargesController } from "./stored-value-recharges.controller.js";
import { StoredValueRechargesService } from "./stored-value-recharges.service.js";

@Module({
  imports: [AuthModule, OrdersModule],
  controllers: [
    PaymentsController,
    WechatPaymentsController,
    PaymentReconciliationController,
    RefundsController,
    StoredValueRechargesController,
  ],
  providers: [
    PaymentsService,
    PaymentGatewayService,
    PaymentExpiryWorker,
    WechatPayClient,
    WechatPrepayService,
    WechatPaymentsService,
    WechatRecoveryService,
    WechatRecoveryWorker,
    PaymentReconciliationService,
    RefundsService,
    RefundReconciliationWorker,
    StoredValueRechargesService,
  ],
  exports: [PaymentsService, PaymentGatewayService],
})
export class PaymentsModule {}
