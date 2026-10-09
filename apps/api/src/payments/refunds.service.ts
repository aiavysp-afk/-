import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  OrderStatus,
  PaymentProvider,
  PaymentStatus,
  Prisma,
  RefundStatus,
  ReservationStatus,
  type Refund,
} from "@prisma/client";
import {
  IdempotencyKeySchema,
  type AdminPaymentView,
  type RefundRequest,
  type RefundReview,
  type RefundView,
} from "@zydj/contracts";
import { createHash, randomBytes } from "node:crypto";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { AccessControlService } from "../auth/access-control.service.js";
import type { AppEnv } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { OrderStateMachine } from "../orders/order-state-machine.js";
import { calculateRefund, REFUND_POLICY_VERSION } from "./refund-policy.js";
import { WechatPayClient } from "./wechat-pay.client.js";
import {
  parseWechatRefund,
  type WechatHeaders,
  type WechatRefundResult,
} from "./wechat-pay.protocol.js";

type RefundWithPayment = Prisma.RefundGetPayload<{
  include: { payment: { include: { order: true } } };
}>;
type Trace = {
  id: string;
  paymentId: string;
  orderId: string;
  organizationId: string;
};
const IN_FLIGHT = new Set<RefundStatus>([
  RefundStatus.PROCESSING,
  RefundStatus.UNKNOWN,
  RefundStatus.ABNORMAL,
  RefundStatus.CLOSED,
]);

@Injectable()
export class RefundsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly config: ConfigService<AppEnv, true>,
    private readonly client: WechatPayClient,
    private readonly stateMachine: OrderStateMachine,
  ) {}

  async request(
    principal: AuthPrincipal,
    organizationId: string,
    paymentId: string,
    input: RefundRequest,
    idempotencyKey: string,
  ) {
    this.access.assertPermission(principal, "finance.request", organizationId);
    return this.createRequest(
      principal,
      organizationId,
      paymentId,
      input,
      idempotencyKey,
    );
  }

  async requestOwn(
    principal: AuthPrincipal,
    orderId: string,
    idempotencyKey: string,
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });
    if (!order) throw new NotFoundException("订单不存在");
    if (order.customerId !== principal.userId)
      throw new ForbiddenException("不能申请其他客户的退款");
    const replay = await this.prisma.refund.findFirst({
      where: {
        payment: { orderId },
        idempotencyKey,
        requestedById: principal.userId,
      },
      include: { payment: true },
    });
    if (replay)
      return this.createRequest(
        principal,
        order.organizationId,
        replay.paymentId,
        { reason: replay.reason },
        idempotencyKey,
      );
    const payment = await this.prisma.payment.findFirst({
      where: { orderId, status: PaymentStatus.SUCCEEDED },
      orderBy: { createdAt: "desc" },
    });
    if (!payment) throw new ConflictException("没有可退款的成功支付");
    return this.createRequest(
      principal,
      order.organizationId,
      payment.id,
      {
        reason:
          payment.failureCode === "FULFILLMENT_REVIEW_REQUIRED"
            ? "LATE_PAYMENT"
            : "CUSTOMER_CANCELLED",
      },
      idempotencyKey,
    );
  }

  private async createRequest(
    principal: AuthPrincipal,
    organizationId: string,
    paymentId: string,
    input: RefundRequest,
    idempotencyKey: string,
  ) {
    if (!IdempotencyKeySchema.safeParse(idempotencyKey).success)
      throw new BadRequestException("退款幂等键无效");
    const initial = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { order: true },
    });
    if (!initial) throw new NotFoundException("支付记录不存在");
    if (initial.order.organizationId !== organizationId)
      throw new ForbiddenException("支付不属于指定组织");
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          reason: input.reason,
          requestedById: principal.userId,
        }),
      )
      .digest("hex");
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${initial.orderId} FOR UPDATE`;
      const payment = await tx.payment.findUniqueOrThrow({
        where: { id: paymentId },
        include: { order: true },
      });
      const replay = await tx.refund.findUnique({
        where: { paymentId_idempotencyKey: { paymentId, idempotencyKey } },
      });
      if (replay) {
        if (replay.requestFingerprint !== fingerprint)
          throw new ConflictException("同一幂等键不能复用于不同退款申请");
        return this.view(replay, payment.orderId);
      }
      const amountFen = calculateRefund(
        payment,
        payment.order.status,
        input.reason,
      );
      const refund = await tx.refund.create({
        data: {
          paymentId,
          amountFen,
          reason: input.reason,
          policyVersion: REFUND_POLICY_VERSION,
          requestedById: principal.userId,
          idempotencyKey,
          requestFingerprint: fingerprint,
          merchantRefundNo: `RF${Date.now()}${randomBytes(8).toString("hex").toUpperCase()}`,
        },
      });
      await tx.payment.update({
        where: { id: paymentId },
        data: { refundReservedFen: { increment: amountFen } },
      });
      await this.record(
        tx,
        { id: refund.id, paymentId, orderId: payment.orderId, organizationId },
        "REFUND_REQUESTED",
        principal.userId,
        {
          amountFen: amountFen.toString(),
          reason: input.reason,
          policyVersion: refund.policyVersion,
        },
      );
      return this.view(refund, payment.orderId);
    });
  }

  async review(
    principal: AuthPrincipal,
    organizationId: string,
    refundId: string,
    approved: boolean,
    input: RefundReview,
  ) {
    this.access.assertPermission(principal, "finance.approve", organizationId);
    const initial = await this.scoped(refundId, organizationId);
    if (initial.requestedById === principal.userId)
      throw new ForbiddenException("不能复核自己申请的退款");
    if (approved ? input.code !== "CONFIRMED" : input.code === "CONFIRMED")
      throw new BadRequestException("复核结论与操作不一致");
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${initial.payment.orderId} FOR UPDATE`;
      const refund = await this.fresh(tx, refundId);
      const expected = approved ? RefundStatus.APPROVED : RefundStatus.REJECTED;
      if (
        refund.status === expected ||
        (approved &&
          ["PROCESSING", "UNKNOWN", "ABNORMAL", "CLOSED", "SUCCEEDED"].includes(
            refund.status,
          ))
      )
        return this.view(refund, refund.payment.orderId);
      if (refund.status !== RefundStatus.REQUESTED)
        throw new ConflictException("退款状态已变化，不能重新复核");
      if (approved) {
        if (refund.policyVersion !== REFUND_POLICY_VERSION)
          throw new ConflictException("退款规则版本已变化，需要重新核实申请");
        // Recheck fulfillment after acquiring the order lock; no stale policy approval.
        const withoutOwnReservation = {
          ...refund.payment,
          refundReservedFen:
            refund.payment.refundReservedFen - refund.amountFen,
        };
        if (
          calculateRefund(
            withoutOwnReservation,
            refund.payment.order.status,
            refund.reason,
          ) !== refund.amountFen
        )
          throw new ConflictException("退款额度或履约状态已变化");
        const next = this.stateMachine.transition(
          refund.payment.order.status,
          "REFUND_STARTED",
        );
        await tx.payment.update({
          where: { id: refund.paymentId },
          data: { status: PaymentStatus.REFUNDING },
        });
        await tx.order.update({
          where: { id: refund.payment.orderId },
          data: { status: next },
        });
        if (refund.payment.order.reservationId)
          await tx.appointmentReservation.updateMany({
            where: {
              id: refund.payment.order.reservationId,
              status: {
                in: [ReservationStatus.HOLD, ReservationStatus.CONFIRMED],
              },
            },
            data: { status: ReservationStatus.RELEASED },
          });
      } else {
        await tx.payment.update({
          where: { id: refund.paymentId },
          data: { refundReservedFen: { decrement: refund.amountFen } },
        });
      }
      const updated = await tx.refund.update({
        where: { id: refundId },
        data: {
          status: expected,
          reviewedById: principal.userId,
          reviewCode: input.code,
          reviewedAt: new Date(),
        },
      });
      await this.record(
        tx,
        this.trace(refund),
        approved ? "REFUND_APPROVED" : "REFUND_REJECTED",
        principal.userId,
        { code: input.code },
      );
      return this.view(updated, refund.payment.orderId);
    });
  }

  async submit(
    principal: AuthPrincipal,
    organizationId: string,
    refundId: string,
  ) {
    this.access.assertPermission(principal, "finance.approve", organizationId);
    const initial = await this.scoped(refundId, organizationId);
    if (initial.requestedById === principal.userId)
      throw new ForbiddenException("退款申请人不能自行提交渠道退款");
    const real = initial.payment.provider === PaymentProvider.WECHAT;
    if (real) this.client.assertRefundEnabled();
    else this.assertMock();
    // Persist the original refund number BEFORE network I/O. Never retry POST after uncertainty.
    const claimed = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${initial.payment.orderId} FOR UPDATE`;
      const refund = await this.fresh(tx, refundId);
      if (
        IN_FLIGHT.has(refund.status) ||
        refund.status === RefundStatus.SUCCEEDED
      )
        return { send: false, refund };
      if (refund.status !== RefundStatus.APPROVED || !refund.reviewedById)
        throw new ConflictException("退款尚未完成复核");
      const updated = await tx.refund.update({
        where: { id: refundId },
        data: {
          status: RefundStatus.PROCESSING,
          submittedAt: new Date(),
          nextCheckAt: real ? new Date(Date.now() + 120_000) : null,
        },
        include: { payment: { include: { order: true } } },
      });
      await this.record(
        tx,
        this.trace(refund),
        real ? "WECHAT_REFUND_SUBMITTED" : "MOCK_REFUND_SUBMITTED",
        principal.userId,
        {},
      );
      return { send: true, refund: updated };
    });
    if (real && claimed.send) {
      try {
        const refund = claimed.refund;
        const result = await this.client.submitRefund(
          this.client.buildRefundRequest({
            transactionId: refund.payment.providerTransactionId ?? "",
            outRefundNo: refund.merchantRefundNo,
            refundFen: this.money(refund.amountFen),
            totalFen: this.money(refund.payment.amountFen),
            reason: refund.reason,
          }),
        );
        if (result.out_refund_no !== refund.merchantRefundNo)
          throw new ConflictException("渠道退款号不一致");
        await this.applyResult(
          result,
          `REFUND_SUBMIT:${result.refund_id}:${result.status}`,
          "QUERY",
        );
      } catch {
        await this.markUnknown(refundId);
        throw new ServiceUnavailableException(
          "渠道退款结果未知，额度保留，请查询原退款单；禁止另建单重试",
        );
      }
    }
    const current = await this.scoped(refundId, organizationId);
    return this.view(current, current.payment.orderId);
  }

  async confirmMock(
    principal: AuthPrincipal,
    organizationId: string,
    refundId: string,
  ) {
    this.assertMock();
    this.access.assertPermission(principal, "finance.approve", organizationId);
    const refund = await this.scoped(refundId, organizationId);
    if (refund.requestedById === principal.userId)
      throw new ForbiddenException("退款申请人不能自行确认退款结果");
    if (refund.payment.provider !== PaymentProvider.MOCK)
      throw new ConflictException("该退款不是 Mock 退款");
    const result: WechatRefundResult = {
      mchid: "mock",
      out_trade_no: refund.payment.merchantPaymentNo,
      transaction_id: refund.payment.providerTransactionId ?? "",
      out_refund_no: refund.merchantRefundNo,
      refund_id: `mock-${refund.id}`,
      status: "SUCCESS",
      success_time: new Date().toISOString(),
      amount: {
        total: this.money(refund.payment.amountFen),
        refund: this.money(refund.amountFen),
        currency: "CNY",
      },
    };
    await this.applyResult(result, `MOCK_REFUND:${refund.id}`, "MOCK");
    const current = await this.scoped(refundId, organizationId);
    return this.view(current, current.payment.orderId);
  }

  async notify(rawBody: Buffer, headers: WechatHeaders) {
    const { eventId, result } = this.client.decodeRefundNotification(
      rawBody,
      headers,
    );
    return this.applyResult(result, `WECHAT_REFUND:${eventId}`, "NOTIFICATION");
  }

  async reconcile(
    principal: AuthPrincipal,
    organizationId: string,
    refundId: string,
  ) {
    this.access.assertPermission(principal, "finance.approve", organizationId);
    await this.scoped(refundId, organizationId);
    await this.queryProvider(refundId);
    const current = await this.scoped(refundId, organizationId);
    return this.view(current, current.payment.orderId);
  }

  async queryProvider(refundId: string) {
    const refund = await this.prisma.refund.findUnique({
      where: { id: refundId },
      include: { payment: { include: { order: true } } },
    });
    if (!refund) throw new NotFoundException("退款记录不存在");
    if (
      refund.payment.provider !== PaymentProvider.WECHAT ||
      !refund.submittedAt ||
      !IN_FLIGHT.has(refund.status)
    ) {
      if (refund.status === RefundStatus.SUCCEEDED) return;
      throw new ConflictException("该退款尚未提交微信渠道或无需查询");
    }
    let result: WechatRefundResult;
    try {
      result = await this.client.queryRefund(refund.merchantRefundNo);
    } catch (error) {
      await this.markUnknown(refundId);
      throw error;
    }
    if (result.out_refund_no !== refund.merchantRefundNo) {
      await this.markUnknown(refundId);
      throw new ConflictException("查单退款号与申请不一致");
    }
    try {
      await this.applyResult(
        result,
        `REFUND_QUERY:${result.refund_id}:${result.status}`,
        "QUERY",
      );
    } catch (error) {
      await this.markUnknown(refundId);
      throw error;
    }
  }

  async markUnknown(refundId: string) {
    const initial = await this.prisma.refund.findUniqueOrThrow({
      where: { id: refundId },
      include: { payment: { include: { order: true } } },
    });
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${initial.payment.orderId} FOR UPDATE`;
      const refund = await this.fresh(tx, refundId);
      if (refund.status !== RefundStatus.PROCESSING) return;
      await tx.refund.update({
        where: { id: refundId },
        data: { status: RefundStatus.UNKNOWN },
      });
      await this.record(
        tx,
        this.trace(refund),
        "REFUND_RESULT_UNKNOWN",
        undefined,
        { action: "QUERY_SAME_REFUND_NUMBER" },
      );
    });
  }

  async applyResult(
    input: WechatRefundResult,
    eventId: string,
    source: "NOTIFICATION" | "QUERY" | "MOCK",
  ) {
    const merchantId =
      source === "MOCK" ? "mock" : this.client.verifierConfig().merchantId;
    if (source === "MOCK") this.assertMock();
    const result = parseWechatRefund(input, merchantId);
    if (
      result.success_time &&
      Date.parse(result.success_time) > Date.now() + 300_000
    )
      throw new BadRequestException("退款成功时间无效");
    const initial = await this.prisma.refund.findUnique({
      where: { merchantRefundNo: result.out_refund_no },
      include: { payment: { include: { order: true } } },
    });
    if (
      !initial ||
      initial.payment.provider !==
        (source === "MOCK" ? PaymentProvider.MOCK : PaymentProvider.WECHAT)
    )
      throw new NotFoundException("退款渠道记录不存在");
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${initial.payment.orderId} FOR UPDATE`;
        const refund = await this.fresh(tx, initial.id);
        const payment = refund.payment;
        if (
          result.transaction_id !== payment.providerTransactionId ||
          result.out_trade_no !== payment.merchantPaymentNo ||
          BigInt(result.amount.total) !== payment.amountFen ||
          BigInt(result.amount.refund) !== refund.amountFen
        )
          throw new ConflictException("退款金额或原支付流水不一致");
        if (
          refund.providerRefundId &&
          refund.providerRefundId !== result.refund_id
        )
          throw new ConflictException("微信退款流水冲突");
        const previous = await tx.refundEvent.findUnique({
          where: { providerEventId: eventId },
        });
        if (previous && previous.refundId !== refund.id)
          throw new ConflictException("退款通知 ID 冲突");
        if (refund.status === RefundStatus.SUCCEEDED)
          return { duplicate: true };
        if (!IN_FLIGHT.has(refund.status) || !refund.submittedAt)
          throw new ConflictException("退款尚未提交渠道，不能确认结果");
        const next: RefundStatus =
          result.status === "SUCCESS" ? RefundStatus.SUCCEEDED : result.status;
        // Do not let stale processing notifications erase an exception/closed result.
        if (
          previous ||
          (next === refund.status && !!refund.providerRefundId) ||
          (next === RefundStatus.PROCESSING &&
            ["ABNORMAL", "CLOSED"].includes(refund.status))
        )
          return { duplicate: true };
        if (next === RefundStatus.SUCCEEDED) {
          if (
            payment.refundReservedFen < refund.amountFen ||
            payment.refundedFen + refund.amountFen > payment.amountFen
          )
            throw new ConflictException("退款可退额度不一致，需要财务核实");
          const fullyRefunded =
            payment.refundedFen + refund.amountFen === payment.amountFen;
          await tx.payment.update({
            where: { id: payment.id },
            data: {
              refundReservedFen: { decrement: refund.amountFen },
              refundedFen: { increment: refund.amountFen },
              status: fullyRefunded
                ? PaymentStatus.REFUNDED
                : PaymentStatus.REFUNDING,
            },
          });
          if (fullyRefunded) {
            const nextOrder = this.stateMachine.transition(
              payment.order.status,
              "REFUND_SUCCEEDED",
            );
            await tx.order.update({
              where: { id: payment.orderId },
              data: { status: nextOrder },
            });
          }
          await tx.refundLedgerPosting.create({
            data: { refundId: refund.id, amountFen: refund.amountFen },
          });
        }
        await tx.refund.update({
          where: { id: refund.id },
          data: {
            status: next,
            providerRefundId: result.refund_id,
            succeededAt:
              next === RefundStatus.SUCCEEDED
                ? new Date(result.success_time!)
                : null,
            nextCheckAt:
              next === RefundStatus.SUCCEEDED || next === RefundStatus.CLOSED
                ? null
                : refund.nextCheckAt,
          },
        });
        await this.record(
          tx,
          this.trace(refund),
          `REFUND_${next}`,
          undefined,
          {
            source,
            providerRefundId: result.refund_id,
            amountFen: refund.amountFen.toString(),
          },
          eventId,
        );
        return { duplicate: false };
      },
      { timeout: 3500, maxWait: 1000 },
    );
  }

  async listOwn(principal: AuthPrincipal, orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });
    if (!order) throw new NotFoundException("订单不存在");
    if (order.customerId !== principal.userId)
      throw new ForbiddenException("不能查看其他客户的退款");
    const rows = await this.prisma.refund.findMany({
      where: { payment: { orderId } },
      orderBy: { requestedAt: "desc" },
      take: 50,
    });
    return rows.map((row) => this.view(row, orderId));
  }

  async listStaff(
    principal: AuthPrincipal,
    organizationId: string,
    paymentId: string,
  ) {
    if (
      !this.access.hasPermission(principal, "finance.request", organizationId)
    )
      this.access.assertPermission(
        principal,
        "finance.approve",
        organizationId,
      );
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { order: true },
    });
    if (!payment) throw new NotFoundException("支付不存在");
    if (payment.order.organizationId !== organizationId)
      throw new ForbiddenException("支付不属于指定组织");
    const rows = await this.prisma.refund.findMany({
      where: { paymentId },
      include: { events: { orderBy: { createdAt: "asc" } } },
      orderBy: { requestedAt: "desc" },
      take: 50,
    });
    return rows.map((row) => ({
      ...this.view(row, payment.orderId),
      requestedById: row.requestedById,
      reviewedById: row.reviewedById,
      events: row.events.map((event) => ({
        type: event.type,
        actorId: event.actorId,
        createdAt: event.createdAt.toISOString(),
      })),
    }));
  }

  async listPayments(
    principal: AuthPrincipal,
    organizationId: string,
  ): Promise<AdminPaymentView[]> {
    if (
      !this.access.hasPermission(principal, "finance.request", organizationId)
    )
      this.access.assertPermission(
        principal,
        "finance.approve",
        organizationId,
      );
    const rows = await this.prisma.payment.findMany({
      where: { order: { organizationId } },
      select: {
        id: true,
        orderId: true,
        order: { select: { orderNo: true, status: true } },
        status: true,
        provider: true,
        kind: true,
        payer: { select: { id: true, displayName: true } },
        succeededAt: true,
        amountFen: true,
        refundReservedFen: true,
        refundedFen: true,
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return rows.map((row) => ({
      id: row.id,
      orderId: row.orderId,
      orderNo: row.order.orderNo,
      orderStatus: row.order.status,
      status: row.status,
      provider: row.provider,
      kind: row.kind ?? "SELF",
      payer: row.payer
        ? { userId: row.payer.id, displayName: row.payer.displayName }
        : null,
      succeededAt: row.succeededAt?.toISOString() ?? null,
      amountFen: this.money(row.amountFen),
      reservedFen: this.money(row.refundReservedFen),
      refundedFen: this.money(row.refundedFen),
      availableFen: this.money(
        row.amountFen - row.refundReservedFen - row.refundedFen,
      ),
    }));
  }

  private assertMock() {
    if (
      this.config.get("NODE_ENV", { infer: true }) === "production" ||
      this.config.get("PAYMENT_PROVIDER", { infer: true }) !== "mock"
    )
      throw new NotFoundException("接口不存在");
  }
  private async scoped(id: string, organizationId: string) {
    const refund = await this.prisma.refund.findUnique({
      where: { id },
      include: { payment: { include: { order: true } } },
    });
    if (!refund) throw new NotFoundException("退款记录不存在");
    if (refund.payment.order.organizationId !== organizationId)
      throw new ForbiddenException("退款不属于指定组织");
    return refund;
  }
  private fresh(tx: Prisma.TransactionClient, id: string) {
    return tx.refund.findUniqueOrThrow({
      where: { id },
      include: { payment: { include: { order: true } } },
    });
  }
  private trace(refund: RefundWithPayment): Trace {
    return {
      id: refund.id,
      paymentId: refund.paymentId,
      orderId: refund.payment.orderId,
      organizationId: refund.payment.order.organizationId,
    };
  }
  private async record(
    tx: Prisma.TransactionClient,
    trace: Trace,
    type: string,
    actorId: string | undefined,
    payload: Prisma.InputJsonObject,
    providerEventId?: string,
  ) {
    await tx.refundEvent.create({
      data: { refundId: trace.id, type, actorId, payload, providerEventId },
    });
    await tx.orderEvent.create({
      data: {
        orderId: trace.orderId,
        type,
        actorId,
        payload: { refundId: trace.id },
      },
    });
    await tx.auditLog.create({
      data: {
        organizationId: trace.organizationId,
        actorId,
        action: type,
        resourceType: "Refund",
        resourceId: trace.id,
        metadata: payload,
      },
    });
    await tx.outboxEvent.create({
      data: {
        aggregateId: trace.orderId,
        type,
        payload: {
          refundId: trace.id,
          paymentId: trace.paymentId,
          orderId: trace.orderId,
        },
      },
    });
  }
  private money(value: bigint) {
    const amount = Number(value);
    if (!Number.isSafeInteger(amount) || amount < 0)
      throw new ConflictException("退款金额超出序列化范围");
    return amount;
  }
  private view(refund: Refund, orderId: string): RefundView {
    return {
      id: refund.id,
      paymentId: refund.paymentId,
      orderId,
      amountFen: this.money(refund.amountFen),
      status: refund.status,
      reason: refund.reason,
      policyVersion: refund.policyVersion,
      requestedAt: refund.requestedAt.toISOString(),
      reviewedAt: refund.reviewedAt?.toISOString() ?? null,
      submittedAt: refund.submittedAt?.toISOString() ?? null,
      succeededAt: refund.succeededAt?.toISOString() ?? null,
    };
  }
}
