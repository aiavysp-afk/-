import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  IdentityProvider,
  OrderStatus,
  PaymentProvider,
  PaymentStatus,
  ReservationStatus,
  WechatPrepayState,
  type Payment,
} from "@prisma/client";
import type { PaymentIntent } from "@zydj/contracts";
import { randomBytes } from "node:crypto";
import { AuthCryptoService } from "../auth/auth-crypto.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import type { AppEnv } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { PaymentGatewayService } from "./payment-gateway.service.js";
import { WechatPayClient } from "./wechat-pay.client.js";

@Injectable()
export class WechatPrepayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnv, true>,
    private readonly crypto: AuthCryptoService,
    private readonly gateway: PaymentGatewayService,
    private readonly client: WechatPayClient,
  ) {}

  async createIntent(
    principal: AuthPrincipal,
    orderId: string,
  ): Promise<PaymentIntent> {
    const initial = await this.prisma.order.findUnique({
      where: { id: orderId },
    });
    if (!initial) throw new NotFoundException("订单不存在");
    if (initial.customerId !== principal.userId)
      throw new ForbiddenException("不能支付其他用户的订单");
    this.client.assertPrepayEnabled();
    const openId = await this.payerOpenId(principal.userId);

    // Persist the only dispatch claim before external I/O. A crash/timeout never permits a second POST.
    const prepared = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
      const order = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { payment: true, reservation: true, items: true },
      });
      this.assertPayable(order, principal.userId);
      const expiresAt = order.paymentExpiresAt!;
      const existing = order.payment;
      if (existing) {
        if (
          existing.provider !== PaymentProvider.WECHAT ||
          existing.status !== PaymentStatus.PENDING ||
          existing.amountFen !== order.payableFen
        )
          throw new ConflictException("支付记录与订单不一致");
        return { payment: existing, expiresAt, request: null };
      }
      // WeChat rounds very short deadlines up to one minute; do not exceed the reservation deadline.
      if (expiresAt.getTime() <= Date.now() + 90_000)
        throw new ConflictException(
          "剩余支付时间不足，请等待原单结束后重新预约",
        );
      const item = order.items[0];
      if (!item) throw new ConflictException("订单商品快照缺失");
      const amountFen = Number(order.payableFen);
      if (!Number.isSafeInteger(amountFen) || amountFen <= 0)
        throw new ConflictException("订单支付金额无效");
      const merchantPaymentNo = `PAY${Date.now()}${randomBytes(5).toString("hex").toUpperCase()}`;
      const description = [
        ...`${this.config.get("BRAND_NAME", { infer: true })}-${item.serviceName}`,
      ]
        .slice(0, 127)
        .join("");
      const request = this.gateway.buildWechatJsapiRequest({
        description,
        outTradeNo: merchantPaymentNo,
        totalFen: amountFen,
        payerOpenId: openId,
        expiresAt,
      });
      const payment = await tx.payment.create({
        data: {
          orderId,
          provider: PaymentProvider.WECHAT,
          merchantPaymentNo,
          amountFen: order.payableFen,
          prepayState: WechatPrepayState.DISPATCHING,
          prepayRequestedAt: new Date(),
        },
      });
      await tx.paymentEvent.create({
        data: {
          paymentId: payment.id,
          type: "WECHAT_PREPAY_DISPATCH_CLAIMED",
          payload: {},
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId: order.organizationId,
          action: "WECHAT_PREPAY_DISPATCH_CLAIMED",
          resourceType: "Payment",
          resourceId: payment.id,
          metadata: {},
        },
      });
      return { payment, expiresAt, request };
    });
    if (!prepared.request)
      return this.toIntent(prepared.payment, prepared.expiresAt);

    let prepayId: string;
    try {
      prepayId = await this.client.prepay(prepared.request);
    } catch {
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
        const changed = await tx.payment.updateMany({
          where: {
            id: prepared.payment.id,
            prepayState: WechatPrepayState.DISPATCHING,
          },
          data: {
            prepayState: WechatPrepayState.UNKNOWN,
            prepayFailureCode: "SUBMISSION_UNCERTAIN",
          },
        });
        if (changed.count === 1) {
          await tx.paymentEvent.create({
            data: {
              paymentId: prepared.payment.id,
              type: "WECHAT_PREPAY_UNCERTAIN",
              payload: {},
            },
          });
          await tx.outboxEvent.create({
            data: {
              aggregateId: orderId,
              type: "WECHAT_PREPAY_REVIEW_REQUIRED",
              payload: { orderId, paymentId: prepared.payment.id },
            },
          });
        }
      });
      throw new BadGatewayException(
        "微信预下单结果未确认，请查询原单；不会自动重新发起",
      );
    }
    const current = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
      const payment = await tx.payment.update({
        where: { id: prepared.payment.id },
        data: {
          providerReference: prepayId,
          prepayState: WechatPrepayState.READY,
          prepayReadyAt: new Date(),
          prepayFailureCode: null,
        },
      });
      await tx.paymentEvent.create({
        data: {
          paymentId: payment.id,
          type: "WECHAT_PREPAY_READY",
          payload: {},
        },
      });
      const order = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { reservation: true },
      });
      return { payment, order };
    });
    // Persist the response even if a cancellation/notification won the race, but never expose usable SDK parameters.
    this.assertPayable(current.order, principal.userId);
    if (current.payment.status !== PaymentStatus.PENDING)
      throw new ConflictException("支付结果已变化，请刷新订单");
    return this.toIntent(current.payment, current.order.paymentExpiresAt!);
  }

  private async payerOpenId(userId: string) {
    const identities = await this.prisma.externalIdentity.findMany({
      where: { userId, provider: IdentityProvider.WECHAT_MINIAPP },
      take: 10,
    });
    const appId = this.config.get("WECHAT_MINIAPP_APP_ID", { infer: true });
    const matching: string[] = [];
    for (const identity of identities) {
      try {
        const subject = this.crypto.decrypt(identity.subjectEncrypted);
        if (
          this.crypto.hashIdentity(appId, subject) === identity.subjectHash &&
          subject.length > 0 &&
          subject.length <= 128 &&
          !subject.startsWith("mock-")
        )
          matching.push(subject);
      } catch {
        /* Never expose ciphertext/openid or decryption details. */
      }
    }
    if (matching.length !== 1)
      throw new ServiceUnavailableException(
        "当前小程序微信身份未就绪，请重新微信登录",
      );
    return matching[0]!;
  }

  private assertPayable(
    order: {
      customerId: string;
      status: OrderStatus;
      paymentExpiresAt: Date | null;
      reservation: { status: ReservationStatus; expiresAt: Date } | null;
    },
    customerId: string,
  ) {
    if (order.customerId !== customerId)
      throw new ForbiddenException("不能支付其他用户的订单");
    if (
      order.status !== OrderStatus.PENDING_PAYMENT ||
      !order.paymentExpiresAt ||
      order.paymentExpiresAt.getTime() <= Date.now() ||
      !order.reservation ||
      order.reservation.status !== ReservationStatus.HOLD ||
      order.reservation.expiresAt.getTime() <= Date.now()
    )
      throw new ConflictException("订单或预约支付时段已失效，请刷新订单");
  }

  private toIntent(payment: Payment, expiresAt: Date): PaymentIntent {
    const amountFen = Number(payment.amountFen);
    if (!Number.isSafeInteger(amountFen) || amountFen <= 0)
      throw new ConflictException("支付金额超出安全范围");
    const ready =
      payment.prepayState === WechatPrepayState.READY &&
      !!payment.providerReference &&
      !!payment.prepayReadyAt &&
      payment.prepayReadyAt.getTime() + 7_200_000 > Date.now();
    return {
      id: payment.id,
      orderId: payment.orderId,
      provider: payment.provider,
      status: payment.status,
      amountFen,
      expiresAt: expiresAt.toISOString(),
      mockConfirmationAvailable: false,
      prepayState: payment.prepayState,
      ...(ready
        ? {
            wechatPayParameters: this.client.paymentParameters(
              payment.providerReference!,
            ),
          }
        : {}),
    };
  }
}
