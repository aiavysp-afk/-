import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  OrderStatus,
  PaymentKind,
  PaymentProvider,
  PaymentStatus,
  ReservationStatus,
} from "@prisma/client";
import type {
  FriendPaymentShare,
  FriendPaymentSummary,
  PaymentNotification,
} from "@zydj/contracts";
import { createHash, randomBytes } from "node:crypto";
import type { AuthPrincipal } from "../auth/auth.types.js";
import type { AppEnv } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { WechatPayClient } from "./wechat-pay.client.js";
import { WechatPaymentsService } from "./wechat-payments.service.js";
import { WechatPrepayService } from "./wechat-prepay.service.js";

const RIGHTS_NOTICE =
  "代付成功后资金进入平台，订单权益归下单人；代付人不能发起退款，退款只能由下单用户操作，并原路退回实际微信付款账户。";
const SHARE_SELECT = {
  id: true,
  orderId: true,
  expiresAt: true,
  order: {
    select: {
      id: true,
      customerId: true,
      status: true,
      payableFen: true,
      paymentExpiresAt: true,
      appointmentStart: true,
      organization: { select: { name: true } },
      items: {
        select: { serviceName: true, durationMinutes: true, quantity: true },
      },
      reservation: { select: { status: true, expiresAt: true } },
      payment: {
        select: {
          id: true,
          kind: true,
          provider: true,
          status: true,
          payerUserId: true,
          closeRequestedAt: true,
        },
      },
    },
  },
} as const;

@Injectable()
export class FriendPaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnv, true>,
    private readonly client: WechatPayClient,
    private readonly prepay: WechatPrepayService,
    private readonly wechat: WechatPaymentsService,
  ) {}

  async createShare(
    principal: AuthPrincipal,
    orderId: string,
  ): Promise<FriendPaymentShare> {
    const initial = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { customerId: true },
    });
    if (!initial) throw new NotFoundException("订单不存在");
    if (initial.customerId !== principal.userId)
      throw new ForbiddenException("只有下单人可以邀请好友代付");
    this.assertWechatEnabled();
    const token = randomBytes(32).toString("base64url");
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
      const order = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { reservation: true, payment: true },
      });
      if (order.customerId !== principal.userId)
        throw new ForbiddenException("只有下单人可以邀请好友代付");
      this.assertPending(order);
      if (order.payment)
        throw new ConflictException(
          "订单已创建支付，请等待原支付结果或联系平台，不能改为好友代付",
        );
      const expiresAt = order.paymentExpiresAt!;
      await tx.friendPaymentShare.create({
        data: { orderId, tokenHash: this.tokenHash(token), expiresAt },
      });
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId: order.organizationId,
          action: "FRIEND_PAYMENT_SHARE_CREATED",
          resourceType: "Order",
          resourceId: orderId,
          metadata: {},
        },
      });
      return {
        token,
        miniappPath: `/pages/friend-payment/index?token=${token}`,
        amountFen: this.money(order.payableFen),
        expiresAt: expiresAt.toISOString(),
      };
    });
  }

  async summary(
    principal: AuthPrincipal,
    token: string,
  ): Promise<FriendPaymentSummary> {
    const share = await this.findShare(token);
    const order = share.order;
    const isOrderOwner = order.customerId === principal.userId;
    const paymentClaimedByYou =
      order.payment?.kind === PaymentKind.FRIEND &&
      order.payment.payerUserId === principal.userId;
    const paid =
      order.payment?.status === PaymentStatus.SUCCEEDED ||
      order.payment?.status === PaymentStatus.REFUNDING ||
      order.payment?.status === PaymentStatus.REFUNDED;
    const cancelled = [
      OrderStatus.CANCELLED,
      OrderStatus.REFUNDING,
      OrderStatus.REFUNDED,
    ].includes(order.status as "CANCELLED");
    const expired =
      share.expiresAt.getTime() <= Date.now() ||
      !order.paymentExpiresAt ||
      order.paymentExpiresAt.getTime() <= Date.now();
    const reservationValid =
      order.reservation?.status === ReservationStatus.HOLD &&
      order.reservation.expiresAt.getTime() > Date.now();
    const paymentBlocked =
      !!order.payment &&
      (!paymentClaimedByYou ||
        !!order.payment.closeRequestedAt ||
        order.payment.status !== PaymentStatus.PENDING);
    let gate = true;
    try {
      this.assertWechatEnabled();
    } catch {
      gate = false;
    }
    const state: FriendPaymentSummary["state"] = cancelled
      ? "CANCELLED"
      : paid || order.status !== OrderStatus.PENDING_PAYMENT
        ? "PAID"
        : expired || !reservationValid
          ? "EXPIRED"
          : paymentBlocked
            ? "PAYMENT_IN_PROGRESS"
            : gate
              ? "PENDING_PAYMENT"
              : "UNAVAILABLE";
    return {
      state,
      isOrderOwner,
      paymentClaimedByYou,
      canPay: state === "PENDING_PAYMENT" && !isOrderOwner,
      serviceItems: order.items.map(
        ({ serviceName, durationMinutes, quantity }) => ({
          serviceName,
          durationMinutes,
          quantity,
        }),
      ),
      serviceProviderName: order.organization.name,
      appointmentAt: order.appointmentStart.toISOString(),
      amountFen: this.money(order.payableFen),
      expiresAt: share.expiresAt.toISOString(),
      rightsNotice: RIGHTS_NOTICE,
    };
  }

  async createIntent(principal: AuthPrincipal, token: string) {
    this.assertWechatEnabled();
    const share = await this.findShare(token);
    if (share.expiresAt.getTime() <= Date.now())
      throw new ConflictException("代付邀请已失效，请联系下单人");
    return this.prepay.createFriendIntent(principal, share.orderId, share.id);
  }

  async reconcile(principal: AuthPrincipal, token: string) {
    const share = await this.findShare(token);
    const payment = share.order.payment;
    if (
      !payment ||
      payment.kind !== PaymentKind.FRIEND ||
      payment.payerUserId !== principal.userId
    )
      throw new ForbiddenException("只有该订单已绑定的代付人可以查询代付结果");
    // Reconciliation is allowed after share expiry: an uncertain real payment must still be recoverable.
    return this.wechat.reconcileFriend(principal, payment.id);
  }

  async readIntent(principal: AuthPrincipal, token: string) {
    this.assertWechatEnabled();
    const share = await this.findShare(token);
    return this.prepay.readFriendIntent(principal, share.orderId, share.id);
  }

  async notifications(
    principal: AuthPrincipal,
  ): Promise<PaymentNotification[]> {
    const events = await this.prisma.orderEvent.findMany({
      where: {
        order: { customerId: principal.userId },
        OR: [
          {
            type: "FRIEND_PAYMENT_SUCCEEDED",
            order: { customerHiddenAt: null },
          },
          // Hiding order history cannot hide a subsequent real money receipt
          // that still needs platform review or an original-account refund.
          { type: "FRIEND_PAYMENT_FULFILLMENT_REVIEW_REQUIRED" },
        ],
      },
      select: { id: true, orderId: true, type: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return events.map((event) => ({
      id: event.id,
      orderId: event.orderId,
      createdAt: event.createdAt.toISOString(),
      title:
        event.type === "FRIEND_PAYMENT_SUCCEEDED"
          ? "好友代付成功"
          : "好友代付已到账，服务需核实",
      body:
        event.type === "FRIEND_PAYMENT_SUCCEEDED"
          ? "好友已为您的订单完成微信付款，订单已支付，可正常安排服务。"
          : "微信付款已确认，但原预约已失效或订单已取消，请联系平台核实服务或原路退款。",
    }));
  }

  private findShare(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new NotFoundException("代付邀请不存在或已失效");
    return this.prisma.friendPaymentShare
      .findUnique({
        where: { tokenHash: this.tokenHash(token) },
        select: SHARE_SELECT,
      })
      .then((share) => {
        if (!share) throw new NotFoundException("代付邀请不存在或已失效");
        return share;
      });
  }

  private tokenHash(token: string) {
    return createHash("sha256")
      .update(`friend-payment\0${token}`)
      .digest("hex");
  }
  private money(value: bigint) {
    const amount = Number(value);
    if (!Number.isSafeInteger(amount) || amount <= 0)
      throw new ConflictException("订单支付金额无效");
    return amount;
  }
  private assertWechatEnabled() {
    if (this.config.get("PAYMENT_PROVIDER", { infer: true }) !== "wechat")
      throw new ServiceUnavailableException("好友代付仅支持已开通的微信支付");
    this.client.assertPrepayEnabled();
  }
  private assertPending(order: {
    status: OrderStatus;
    paymentExpiresAt: Date | null;
    reservation: { status: ReservationStatus; expiresAt: Date } | null;
  }) {
    if (
      order.status !== OrderStatus.PENDING_PAYMENT ||
      !order.paymentExpiresAt ||
      order.paymentExpiresAt.getTime() <= Date.now() + 90_000 ||
      order.reservation?.status !== ReservationStatus.HOLD ||
      order.reservation.expiresAt.getTime() <= Date.now()
    )
      throw new ConflictException("订单或预约支付时段已失效，请刷新订单");
  }
}
