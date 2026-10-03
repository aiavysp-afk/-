import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { OrderStatus, PaymentProvider, PaymentStatus, ReservationStatus } from "@prisma/client";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { PrismaService } from "../database/prisma.service.js";
import { WechatPayClient } from "./wechat-pay.client.js";
import type { WechatHeaders, WechatTransaction } from "./wechat-pay.protocol.js";

@Injectable()
export class WechatPaymentsService {
  constructor(private readonly prisma: PrismaService, private readonly client: WechatPayClient) {}

  async notify(rawBody: Buffer, headers: WechatHeaders) {
    const { eventId, transaction } = this.client.decodeNotification(rawBody, headers);
    return this.applyTransaction(transaction, eventId, "NOTIFICATION");
  }

  async reconcile(principal: AuthPrincipal, paymentId: string) {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId }, include: { order: true } });
    if (!payment) throw new NotFoundException("支付记录不存在");
    if (payment.order.customerId !== principal.userId) throw new ForbiddenException("不能查询其他用户的支付");
    if (payment.provider !== PaymentProvider.WECHAT) throw new ConflictException("该支付不是微信支付");
    const transaction = await this.client.queryTransaction(payment.merchantPaymentNo);
    if (transaction.out_trade_no !== payment.merchantPaymentNo || BigInt(transaction.amount.total) !== payment.amountFen) throw new ConflictException("查单结果与支付记录不一致");
    if (transaction.trade_state === "SUCCESS") {
      await this.applyTransaction(transaction, `QUERY:${transaction.transaction_id}`, "QUERY");
    }
    // Non-success query results cannot prove a local order is safe to release.
    const current = await this.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    return { id: current.id, status: current.status, providerState: transaction.trade_state, fulfillmentReviewRequired: current.failureCode === "FULFILLMENT_REVIEW_REQUIRED" };
  }

  async applyTransaction(transaction: WechatTransaction, eventId: string, source: "NOTIFICATION" | "QUERY") {
    const identity = this.client.verifierConfig();
    if (transaction.appid !== identity.appId || transaction.mchid !== identity.merchantId || transaction.trade_type !== "JSAPI" || transaction.trade_state !== "SUCCESS" || !transaction.transaction_id || !transaction.success_time) throw new BadRequestException("微信支付交易与当前配置不一致");
    const succeededAt = new Date(transaction.success_time);
    const now = new Date();
    if (!Number.isFinite(succeededAt.getTime()) || succeededAt.getTime() > now.getTime() + 300_000) throw new BadRequestException("微信支付成功时间无效");
    const initial = await this.prisma.payment.findUnique({ where: { merchantPaymentNo: transaction.out_trade_no } });
    if (!initial || initial.provider !== PaymentProvider.WECHAT) throw new NotFoundException("微信支付记录不存在");

    return this.prisma.$transaction(async (tx) => {
      // All payment/expiry paths lock the order first, preventing callback/expiry races.
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${initial.orderId} FOR UPDATE`;
      const payment = await tx.payment.findUniqueOrThrow({ where: { id: initial.id }, include: { order: { include: { reservation: true } } } });
      if (BigInt(transaction.amount.total) !== payment.amountFen || payment.amountFen !== payment.order.payableFen || transaction.amount.currency !== "CNY") throw new ConflictException("微信支付金额与订单不一致");
      const previous = await tx.paymentEvent.findUnique({ where: { providerEventId: eventId } });
      if (previous && previous.paymentId !== payment.id) throw new ConflictException("微信通知 ID 与支付记录冲突");
      if (payment.providerTransactionId) {
        if (payment.providerTransactionId !== transaction.transaction_id) throw new ConflictException("微信支付流水冲突");
        if (new Set<PaymentStatus>([PaymentStatus.SUCCEEDED, PaymentStatus.REFUNDING, PaymentStatus.REFUNDED]).has(payment.status)) return { duplicate: true };
      }
      if (previous) throw new ConflictException("微信支付事件状态不一致");
      if (!new Set<PaymentStatus>([PaymentStatus.PENDING, PaymentStatus.CLOSED]).has(payment.status)) throw new ConflictException("当前支付状态不能接收成功通知");
      const order = payment.order;
      const reservation = order.reservation;
      const canFulfill = payment.status === PaymentStatus.PENDING && order.status === OrderStatus.PENDING_PAYMENT && !!order.paymentExpiresAt && succeededAt <= order.paymentExpiresAt && !!reservation && reservation.status === ReservationStatus.HOLD && reservation.expiresAt > now;

      await tx.payment.update({ where: { id: payment.id }, data: { status: PaymentStatus.SUCCEEDED, providerTransactionId: transaction.transaction_id, succeededAt, failureCode: canFulfill ? null : "FULFILLMENT_REVIEW_REQUIRED" } });
      if (canFulfill && reservation) {
        await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.PAID } });
        const changed = await tx.appointmentReservation.updateMany({ where: { id: reservation.id, status: ReservationStatus.HOLD, expiresAt: { gt: now } }, data: { status: ReservationStatus.CONFIRMED } });
        if (changed.count !== 1) throw new ConflictException("预约状态在支付确认期间发生变化");
      } else if (order.status === OrderStatus.PENDING_PAYMENT) {
        await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.CANCELLED } });
        if (reservation) await tx.appointmentReservation.updateMany({ where: { id: reservation.id, status: ReservationStatus.HOLD }, data: { status: ReservationStatus.EXPIRED } });
      }
      const type = canFulfill ? "PAYMENT_SUCCEEDED" : "PAYMENT_FULFILLMENT_REVIEW_REQUIRED";
      // Store only identifiers and outcome. Decrypted payer/bank data never enter logs.
      await tx.paymentEvent.create({ data: { paymentId: payment.id, type: `WECHAT_${type}`, providerEventId: eventId, payload: { transactionId: transaction.transaction_id, source, fulfillmentReviewRequired: !canFulfill } } });
      await tx.orderEvent.create({ data: { orderId: order.id, type, payload: { paymentId: payment.id } } });
      await tx.auditLog.create({ data: { organizationId: order.organizationId, action: `WECHAT_${type}`, resourceType: "Payment", resourceId: payment.id, metadata: { orderId: order.id, source } } });
      await tx.outboxEvent.create({ data: { aggregateId: order.id, type, payload: { orderId: order.id, paymentId: payment.id } } });
      return { duplicate: false };
    }, { timeout: 3500, maxWait: 1000 });
  }
}
