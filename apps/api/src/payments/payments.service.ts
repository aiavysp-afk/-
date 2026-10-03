import {
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  OrderStatus,
  PaymentProvider,
  PaymentStatus,
  Prisma,
  ReservationStatus,
  type Payment,
} from "@prisma/client";
import type { PaymentIntent } from "@zydj/contracts";
import { randomBytes } from "node:crypto";
import type { AuthPrincipal } from "../auth/auth.types.js";
import type { AppEnv } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { OrderStateMachine } from "../orders/order-state-machine.js";
import { PaymentGatewayService } from "./payment-gateway.service.js";
import { WechatPrepayService } from "./wechat-prepay.service.js";
import { Optional } from "@nestjs/common";

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnv, true>,
    private readonly stateMachine: OrderStateMachine,
    private readonly gateway: PaymentGatewayService,
    @Optional() private readonly wechatPrepay?: WechatPrepayService,
  ) {}

  async createIntent(principal: AuthPrincipal, orderId: string) {
    if (this.config.get("PAYMENT_PROVIDER", { infer: true }) === "wechat") {
      if (!this.wechatPrepay)
        throw new InternalServerErrorException("微信预下单服务未配置");
      return this.wechatPrepay.createIntent(principal, orderId);
    }
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { payment: true },
    });
    if (!order) throw new NotFoundException("订单不存在");
    if (order.customerId !== principal.userId) {
      throw new ForbiddenException("不能支付其他用户的订单");
    }
    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      throw new ConflictException("当前订单状态不能创建支付");
    }
    if (!order.paymentExpiresAt) {
      throw new InternalServerErrorException("订单缺少支付截止时间");
    }
    if (order.paymentExpiresAt.getTime() <= Date.now()) {
      await this.expirePendingOrders(new Date(), order.id);
      throw new ConflictException("订单支付时间已过期");
    }
    if (order.payment)
      return this.toIntent(order.payment, order.paymentExpiresAt);

    const merchantPaymentNo = this.createMerchantPaymentNo();
    const preparation = this.gateway.prepare(merchantPaymentNo);
    try {
      const payment = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${order.id} FOR UPDATE`;
        const currentOrder = await tx.order.findUniqueOrThrow({
          where: { id: order.id },
        });
        if (
          currentOrder.status !== OrderStatus.PENDING_PAYMENT ||
          !currentOrder.paymentExpiresAt ||
          currentOrder.paymentExpiresAt.getTime() <= Date.now()
        )
          throw new ConflictException("订单在创建支付期间已失效");
        const record = await tx.payment.create({
          data: {
            orderId: order.id,
            provider: preparation.provider,
            merchantPaymentNo,
            amountFen: order.payableFen,
            providerReference: preparation.providerReference,
          },
        });
        await tx.paymentEvent.create({
          data: {
            paymentId: record.id,
            type: "PAYMENT_INTENT_CREATED",
            payload: { provider: preparation.provider },
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: principal.userId,
            organizationId: order.organizationId,
            action: "PAYMENT_INTENT_CREATED",
            resourceType: "Payment",
            resourceId: record.id,
            metadata: { provider: preparation.provider },
          },
        });
        return record;
      });
      return this.toIntent(payment, order.paymentExpiresAt);
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== "P2002"
      )
        throw error;
      const existing = await this.prisma.payment.findUnique({
        where: { orderId: order.id },
      });
      if (existing) return this.toIntent(existing, order.paymentExpiresAt);
      throw error;
    }
  }

  async confirmMock(principal: AuthPrincipal, paymentId: string) {
    if (
      this.config.get("NODE_ENV", { infer: true }) === "production" ||
      this.gateway.configuredProvider() !== PaymentProvider.MOCK
    ) {
      throw new NotFoundException("接口不存在");
    }

    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { order: { include: { reservation: true } } },
    });
    if (!payment) throw new NotFoundException("支付记录不存在");
    if (payment.order.customerId !== principal.userId) {
      throw new ForbiddenException("不能确认其他用户的支付");
    }
    if (
      payment.status === PaymentStatus.SUCCEEDED &&
      payment.order.status === OrderStatus.PAID
    ) {
      return this.toIntent(
        payment,
        this.requireExpiry(payment.order.paymentExpiresAt),
      );
    }
    if (
      payment.status !== PaymentStatus.PENDING ||
      payment.order.status !== OrderStatus.PENDING_PAYMENT
    ) {
      throw new ConflictException("当前支付状态不能确认成功");
    }
    const expiresAt = this.requireExpiry(payment.order.paymentExpiresAt);
    const now = new Date();
    if (expiresAt.getTime() <= now.getTime()) {
      await this.expirePendingOrders(now, payment.order.id);
      throw new ConflictException("订单支付时间已过期");
    }
    if (!payment.order.reservation) {
      throw new InternalServerErrorException("订单缺少预约占位");
    }
    const reservation = payment.order.reservation;
    if (payment.amountFen !== payment.order.payableFen) {
      throw new ConflictException("支付金额与订单金额不一致");
    }
    const next = this.stateMachine.transition(
      payment.order.status,
      "PAYMENT_SUCCEEDED",
    );
    const providerTransactionId = `mock-${payment.id}`;

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${payment.order.id} FOR UPDATE`;
      const current = await tx.payment.findUniqueOrThrow({
        where: { id: payment.id },
      });
      if (
        current.status === PaymentStatus.SUCCEEDED &&
        current.providerTransactionId === providerTransactionId
      )
        return current;
      const paymentUpdate = await tx.payment.updateMany({
        where: { id: payment.id, status: PaymentStatus.PENDING },
        data: {
          status: PaymentStatus.SUCCEEDED,
          providerTransactionId,
          succeededAt: now,
        },
      });
      const orderUpdate = await tx.order.updateMany({
        where: { id: payment.order.id, status: OrderStatus.PENDING_PAYMENT },
        data: { status: next },
      });
      const reservationUpdate = await tx.appointmentReservation.updateMany({
        where: {
          id: reservation.id,
          status: ReservationStatus.HOLD,
          expiresAt: { gt: now },
        },
        data: { status: ReservationStatus.CONFIRMED },
      });
      if (
        paymentUpdate.count !== 1 ||
        orderUpdate.count !== 1 ||
        reservationUpdate.count !== 1
      ) {
        throw new ConflictException("支付确认期间订单状态已变化");
      }
      await tx.paymentEvent.create({
        data: {
          paymentId: payment.id,
          type: "MOCK_PAYMENT_SUCCEEDED",
          providerEventId: providerTransactionId,
          payload: {},
        },
      });
      await tx.orderEvent.create({
        data: {
          orderId: payment.order.id,
          type: "PAYMENT_SUCCEEDED",
          actorId: principal.userId,
          payload: { paymentId: payment.id },
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId: payment.order.organizationId,
          action: "MOCK_PAYMENT_SUCCEEDED",
          resourceType: "Payment",
          resourceId: payment.id,
          metadata: { orderId: payment.order.id },
        },
      });
      await tx.outboxEvent.create({
        data: {
          aggregateId: payment.order.id,
          type: "PAYMENT_SUCCEEDED",
          payload: { orderId: payment.order.id, paymentId: payment.id },
        },
      });
      return tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
    });
    return this.toIntent(updated, expiresAt);
  }

  async expirePendingOrders(now = new Date(), onlyOrderId?: string) {
    const orders = await this.prisma.order.findMany({
      where: {
        ...(onlyOrderId ? { id: onlyOrderId } : {}),
        status: OrderStatus.PENDING_PAYMENT,
        paymentExpiresAt: { lte: now },
      },
      include: { payment: true },
      take: onlyOrderId ? 1 : 100,
    });
    let expired = 0;
    for (const order of orders) {
      // A real provider payment needs verified query + remote close before release.
      // This worker currently owns only local/mock expiration.
      if (order.payment?.provider === PaymentProvider.WECHAT) continue;
      const next = this.stateMachine.transition(
        order.status,
        "PAYMENT_EXPIRED",
      );
      const changed = await this.prisma.$transaction(async (tx) => {
        const result = await tx.order.updateMany({
          where: { id: order.id, status: OrderStatus.PENDING_PAYMENT },
          data: { status: next },
        });
        if (result.count !== 1) return false;
        if (order.reservationId) {
          await tx.appointmentReservation.updateMany({
            where: { id: order.reservationId, status: ReservationStatus.HOLD },
            data: { status: ReservationStatus.EXPIRED },
          });
        }
        if (order.payment?.status === PaymentStatus.PENDING) {
          await tx.payment.updateMany({
            where: { id: order.payment.id, status: PaymentStatus.PENDING },
            data: { status: PaymentStatus.CLOSED, closedAt: now },
          });
          await tx.paymentEvent.create({
            data: {
              paymentId: order.payment.id,
              type: "PAYMENT_CLOSED_BY_TIMEOUT",
              payload: {},
            },
          });
        }
        await tx.orderEvent.create({
          data: { orderId: order.id, type: "PAYMENT_EXPIRED", payload: {} },
        });
        await tx.auditLog.create({
          data: {
            organizationId: order.organizationId,
            action: "ORDER_PAYMENT_EXPIRED",
            resourceType: "Order",
            resourceId: order.id,
            metadata: {},
          },
        });
        await tx.outboxEvent.create({
          data: {
            aggregateId: order.id,
            type: "ORDER_PAYMENT_EXPIRED",
            payload: { orderId: order.id },
          },
        });
        return true;
      });
      if (changed) expired += 1;
    }
    return expired;
  }

  private createMerchantPaymentNo() {
    return `PAY${Date.now()}${randomBytes(5).toString("hex").toUpperCase()}`;
  }

  private requireExpiry(value: Date | null) {
    if (!value) throw new InternalServerErrorException("订单缺少支付截止时间");
    return value;
  }

  private safeMoney(value: bigint) {
    const amount = Number(value);
    if (!Number.isSafeInteger(amount)) {
      throw new InternalServerErrorException("支付金额超出安全序列化范围");
    }
    return amount;
  }

  private toIntent(payment: Payment, expiresAt: Date): PaymentIntent {
    return {
      id: payment.id,
      orderId: payment.orderId,
      provider: payment.provider,
      status: payment.status,
      amountFen: this.safeMoney(payment.amountFen),
      expiresAt: expiresAt.toISOString(),
      mockConfirmationAvailable:
        payment.provider === PaymentProvider.MOCK &&
        this.config.get("NODE_ENV", { infer: true }) !== "production",
    };
  }
}
