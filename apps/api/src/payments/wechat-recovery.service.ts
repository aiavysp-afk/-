import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  OrderStatus,
  PaymentProvider,
  PaymentStatus,
  ReservationStatus,
  WechatCloseState,
  type Payment,
  type Prisma,
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { AuthPrincipal } from "../auth/auth.types.js";
import type { AppEnv } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { OrdersService } from "../orders/orders.service.js";
import { WechatPayClient } from "./wechat-pay.client.js";
import {
  parseWechatQueryTransaction,
  parseWechatTransaction,
  type WechatQueryResult,
} from "./wechat-pay.protocol.js";
import { WechatPaymentsService } from "./wechat-payments.service.js";
import { releaseOrderCoupon } from "../customer-center/order-coupons.js";

export const RECOVERY_MAX_ATTEMPTS = 12;
const LEASE_MS = 120_000; // Three bounded channel calls plus DB work fit within this lease.

@Injectable()
export class WechatRecoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnv, true>,
    private readonly client: WechatPayClient,
    private readonly payments: WechatPaymentsService,
    private readonly orders: OrdersService,
  ) {}

  enabled() {
    return (
      this.config.get("PAYMENT_PROVIDER", { infer: true }) === "wechat" &&
      this.config.get("WECHAT_PAY_RECOVERY_ENABLED", { infer: true }) === "true"
    );
  }

  async closeOwnOrder(principal: AuthPrincipal, orderId: string) {
    const initial = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { payment: true },
    });
    if (!initial) throw new NotFoundException("订单不存在");
    if (initial.customerId !== principal.userId)
      throw new ForbiddenException("不能关闭其他用户的订单");
    if (!initial.payment || initial.payment.provider !== PaymentProvider.WECHAT)
      return {
        order: await this.orders.cancelOwn(principal, orderId),
        pendingConfirmation: false,
      };
    // Already terminal returns a view, not another channel action.
    if (
      initial.status === OrderStatus.CANCELLED &&
      initial.payment.status !== PaymentStatus.PENDING
    )
      return {
        order: await this.orders.getOwn(principal, orderId),
        pendingConfirmation: false,
      };
    this.client.assertRecoveryEnabled();
    const paymentId = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
      const order = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { payment: true },
      });
      if (order.customerId !== principal.userId)
        throw new ForbiddenException("不能关闭其他用户的订单");
      if (
        order.status !== OrderStatus.PENDING_PAYMENT ||
        !order.payment ||
        order.payment.provider !== PaymentProvider.WECHAT ||
        order.payment.status !== PaymentStatus.PENDING
      )
        throw new ConflictException("订单状态已变化；已到账订单应走退款申请");
      const payment = order.payment;
      if (!payment.closeRequestedAt) {
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            closeRequestedAt: new Date(),
            closeReason: "CUSTOMER",
            recoveryNextCheckAt: payment.recoveryReviewAt ? null : new Date(),
          },
        });
        await tx.paymentEvent.create({
          data: {
            paymentId: payment.id,
            type: "WECHAT_CLOSE_REQUESTED",
            payload: { reason: "CUSTOMER" },
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: principal.userId,
            organizationId: order.organizationId,
            action: "WECHAT_CLOSE_REQUESTED",
            resourceType: "Payment",
            resourceId: payment.id,
            metadata: { reason: "CUSTOMER" },
          },
        });
      }
      return payment.id;
    });
    await this.recover(paymentId);
    const payment = await this.prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
    });
    return {
      order: await this.orders.getOwn(principal, orderId),
      pendingConfirmation: payment.status === PaymentStatus.PENDING,
      reviewRequired: !!payment.recoveryReviewAt,
    };
  }

  async recover(paymentId: string, now = new Date()) {
    if (!this.enabled()) return false;
    this.client.assertRecoveryEnabled();
    const initial = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });
    if (!initial || initial.provider !== PaymentProvider.WECHAT) return false;
    const claimed = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${initial.orderId} FOR UPDATE`;
      const payment = await tx.payment.findUniqueOrThrow({
        where: { id: paymentId },
        include: { order: { include: { reservation: true } } },
      });
      if (
        payment.provider !== PaymentProvider.WECHAT ||
        payment.status !== PaymentStatus.PENDING ||
        payment.providerTransactionId ||
        payment.recoveryReviewAt ||
        (payment.recoveryLeaseUntil && payment.recoveryLeaseUntil > now) ||
        (payment.recoveryNextCheckAt && payment.recoveryNextCheckAt > now)
      )
        return null;
      // A process may crash after claiming attempt 12; expiry of its lease still escalates once.
      if (payment.recoveryAttempts >= RECOVERY_MAX_ATTEMPTS) {
        await tx.payment.update({
          where: { id: paymentId },
          data: {
            recoveryReviewAt: now,
            recoveryNextCheckAt: null,
            recoveryLeaseToken: null,
            recoveryLeaseUntil: null,
            recoveryFailureCode: "RETRY_LIMIT_REACHED",
          },
        });
        await tx.paymentEvent.create({
          data: {
            paymentId,
            type: "WECHAT_RECOVERY_REVIEW_REQUIRED",
            payload: { code: "RETRY_LIMIT_REACHED" },
          },
        });
        await this.record(tx, payment, "WECHAT_RECOVERY_REVIEW_REQUIRED", {
          code: "RETRY_LIMIT_REACHED",
        });
        return null;
      }
      const order = payment.order;
      const expired =
        (!!order.paymentExpiresAt && order.paymentExpiresAt <= now) ||
        (!!order.reservation && order.reservation.expiresAt <= now);
      const reason = expired
        ? "EXPIRED"
        : order.status === OrderStatus.CANCELLED
          ? "CUSTOMER"
          : null;
      const newClose = !payment.closeRequestedAt && reason;
      const token = randomUUID();
      const current = await tx.payment.update({
        where: { id: payment.id },
        data: {
          recoveryAttempts: { increment: 1 },
          recoveryLeaseToken: token,
          recoveryLeaseUntil: new Date(now.getTime() + LEASE_MS),
          ...(newClose ? { closeRequestedAt: now, closeReason: reason } : {}),
        },
        include: { order: true },
      });
      if (newClose)
        await tx.paymentEvent.create({
          data: {
            paymentId,
            type: "WECHAT_CLOSE_REQUESTED",
            payload: { reason },
          },
        });
      await tx.paymentEvent.create({
        data: {
          paymentId,
          type: "WECHAT_RECOVERY_CLAIMED",
          payload: { attempt: current.recoveryAttempts },
        },
      });
      return { payment: current, token };
    });
    if (!claimed) return false;
    const { payment, token } = claimed;
    let failure = "UNRESOLVED_PROVIDER_STATE";
    try {
      const first = await this.query(payment);
      if (!(await this.observe(paymentId, token, first))) return true;
      if (await this.terminal(payment, token, first)) return true;
      // NOTPAY is not payment failure: close only with a durable customer/expiry intent.
      if (
        first.trade_state === "NOTPAY" &&
        payment.closeRequestedAt &&
        (await this.claimClose(paymentId, payment.orderId, token))
      ) {
        try {
          await this.client.closeTransaction(payment.merchantPaymentNo);
        } catch {
          failure = "CLOSE_RESPONSE_UNCERTAIN";
          await this.prisma.payment.updateMany({
            where: {
              id: paymentId,
              status: PaymentStatus.PENDING,
              recoveryLeaseToken: token,
            },
            data: { closeState: WechatCloseState.UNKNOWN },
          });
        }
        // Also query after timeout/error: channel may have accepted the original close.
        const second = await this.query(payment);
        if (!(await this.observe(paymentId, token, second))) return true;
        if (await this.terminal(payment, token, second)) return true;
      }
    } catch {
      failure = "QUERY_OR_PROTOCOL_UNCERTAIN";
    } finally {
      await this.finish(paymentId, payment.orderId, token, failure);
    }
    return true;
  }

  private async query(payment: Payment & { order: { payableFen: bigint } }) {
    const result = parseWechatQueryTransaction(
      await this.client.queryTransaction(payment.merchantPaymentNo),
      this.client.verifierConfig(),
    );
    if (
      result.out_trade_no !== payment.merchantPaymentNo ||
      payment.amountFen !== payment.order.payableFen ||
      (result.amount?.total !== undefined &&
        BigInt(result.amount.total) !== payment.amountFen)
    )
      throw new ConflictException("原单查单与本地订单不一致");
    return result;
  }

  private async observe(
    paymentId: string,
    token: string,
    result: WechatQueryResult,
  ) {
    const changed = await this.prisma.payment.updateMany({
      where: {
        id: paymentId,
        status: PaymentStatus.PENDING,
        recoveryLeaseToken: token,
        recoveryLeaseUntil: { gt: new Date() },
      },
      data: {
        providerTradeState: result.trade_state,
        providerCheckedAt: new Date(),
      },
    });
    return changed.count === 1;
  }

  private async terminal(
    payment: Payment & { order: { payableFen: bigint } },
    token: string,
    result: WechatQueryResult,
  ) {
    if (result.trade_state === "SUCCESS") {
      const transaction = parseWechatTransaction(
        result,
        this.client.verifierConfig(),
      );
      await this.payments.applyTransaction(
        transaction,
        `QUERY:${transaction.transaction_id}`,
        "QUERY",
      );
      return true;
    }
    if (result.trade_state !== "CLOSED") return false;
    await this.confirmClosed(payment.id, payment.orderId, token);
    return true;
  }

  private async claimClose(paymentId: string, orderId: string, token: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
      const payment = await tx.payment.findUniqueOrThrow({
        where: { id: paymentId },
        include: { order: true },
      });
      if (
        payment.status !== PaymentStatus.PENDING ||
        payment.providerTransactionId ||
        payment.recoveryLeaseToken !== token ||
        !payment.recoveryLeaseUntil ||
        payment.recoveryLeaseUntil <= new Date() ||
        !payment.closeRequestedAt ||
        payment.closeAttempts >= payment.recoveryAttempts ||
        (payment.order.status !== OrderStatus.PENDING_PAYMENT &&
          payment.order.status !== OrderStatus.CANCELLED)
      )
        return false;
      await tx.payment.update({
        where: { id: paymentId },
        data: {
          closeState: WechatCloseState.DISPATCHING,
          closeDispatchedAt: new Date(),
          closeAttempts: { increment: 1 },
        },
      });
      await tx.paymentEvent.create({
        data: {
          paymentId,
          type: "WECHAT_CLOSE_DISPATCHED",
          payload: { attempt: payment.closeAttempts + 1 },
        },
      });
      return true;
    });
  }

  private async confirmClosed(
    paymentId: string,
    orderId: string,
    token: string,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
      const payment = await tx.payment.findUniqueOrThrow({
        where: { id: paymentId },
        include: { order: true },
      });
      // Callback and every lifecycle operation lock Order first. A successful callback always wins over closure.
      if (
        payment.provider !== PaymentProvider.WECHAT ||
        payment.status !== PaymentStatus.PENDING ||
        payment.providerTransactionId ||
        payment.recoveryLeaseToken !== token ||
        !payment.recoveryLeaseUntil ||
        payment.recoveryLeaseUntil <= new Date()
      )
        return;
      if (
        payment.order.status !== OrderStatus.PENDING_PAYMENT &&
        payment.order.status !== OrderStatus.CANCELLED
      )
        throw new ConflictException("订单履约状态不能被关单覆盖");
      const now = new Date();
      await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: PaymentStatus.CLOSED,
          closedAt: now,
          closeState: WechatCloseState.CONFIRMED,
          closeVerifiedAt: now,
          closeRequestedAt: payment.closeRequestedAt ?? now,
          closeReason: payment.closeReason ?? "PROVIDER_CLOSED",
          recoveryNextCheckAt: null,
          recoveryLeaseToken: null,
          recoveryLeaseUntil: null,
          recoveryFailureCode: null,
        },
      });
      if (payment.order.status === OrderStatus.PENDING_PAYMENT)
        await tx.order.update({
          where: { id: orderId },
          data: { status: OrderStatus.CANCELLED },
        });
      await releaseOrderCoupon(tx, orderId, now);
      if (payment.order.reservationId)
        await tx.appointmentReservation.updateMany({
          where: {
            id: payment.order.reservationId,
            status: ReservationStatus.HOLD,
          },
          data: {
            status:
              payment.closeReason === "EXPIRED"
                ? ReservationStatus.EXPIRED
                : ReservationStatus.RELEASED,
          },
        });
      await this.record(tx, payment, "WECHAT_CLOSE_CONFIRMED", {
        providerState: "CLOSED",
        reason: payment.closeReason ?? "PROVIDER_CLOSED",
      });
    });
  }

  private async finish(
    paymentId: string,
    orderId: string,
    token: string,
    failure: string,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
      const payment = await tx.payment.findUniqueOrThrow({
        where: { id: paymentId },
        include: { order: true },
      });
      if (payment.recoveryLeaseToken !== token) return; // A newer owner/callback must never be overwritten.
      const pending = payment.status === PaymentStatus.PENDING;
      const review =
        pending && payment.recoveryAttempts >= RECOVERY_MAX_ATTEMPTS;
      const now = new Date();
      await tx.payment.update({
        where: { id: paymentId },
        data: {
          recoveryLeaseToken: null,
          recoveryLeaseUntil: null,
          recoveryNextCheckAt:
            pending && !review
              ? new Date(
                  now.getTime() +
                    Math.min(
                      3600_000,
                      60_000 * 2 ** Math.min(payment.recoveryAttempts - 1, 6),
                    ),
                )
              : null,
          recoveryFailureCode: pending ? failure : null,
          ...(review ? { recoveryReviewAt: now } : {}),
          ...(pending && payment.closeState === WechatCloseState.DISPATCHING
            ? { closeState: WechatCloseState.UNKNOWN }
            : {}),
        },
      });
      if (pending)
        await tx.paymentEvent.create({
          data: {
            paymentId,
            type: review
              ? "WECHAT_RECOVERY_REVIEW_REQUIRED"
              : "WECHAT_RECOVERY_DEFERRED",
            payload: { attempt: payment.recoveryAttempts, code: failure },
          },
        });
      if (review)
        await this.record(tx, payment, "WECHAT_RECOVERY_REVIEW_REQUIRED", {
          attempt: payment.recoveryAttempts,
          code: failure,
        });
    });
  }

  private async record(
    tx: Prisma.TransactionClient,
    payment: Payment & { order: { organizationId: string } },
    type: string,
    payload: Record<string, string | number>,
  ) {
    await tx.orderEvent.create({
      data: {
        orderId: payment.orderId,
        type,
        payload: { paymentId: payment.id, ...payload },
      },
    });
    await tx.auditLog.create({
      data: {
        organizationId: payment.order.organizationId,
        action: type,
        resourceType: "Payment",
        resourceId: payment.id,
        metadata: payload,
      },
    });
    await tx.outboxEvent.create({
      data: {
        aggregateId: payment.orderId,
        type,
        payload: {
          orderId: payment.orderId,
          paymentId: payment.id,
          ...payload,
        },
      },
    });
    if (type === "WECHAT_CLOSE_CONFIRMED")
      await tx.paymentEvent.create({
        data: { paymentId: payment.id, type, payload },
      });
  }
}
