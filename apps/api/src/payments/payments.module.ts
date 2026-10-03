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

@Module({
  imports: [AuthModule, OrdersModule],
  controllers: [PaymentsController, WechatPaymentsController, PaymentReconciliationController],
  providers: [PaymentsService, PaymentGatewayService, PaymentExpiryWorker, WechatPayClient, WechatPaymentsService, PaymentReconciliationService],
  exports: [PaymentsService, PaymentGatewayService],
})
export class PaymentsModule {}
