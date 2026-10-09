import { Injectable, InternalServerErrorException } from "@nestjs/common";
import {
  OrderStatus,
  PaymentStatus,
  RefundStatus,
  SafetyIncidentStatus,
} from "@prisma/client";
import type { OperationsDashboard } from "@zydj/contracts";
import { AccessControlService } from "../auth/access-control.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { PrismaService } from "../database/prisma.service.js";

const ACTIVE_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.PAID,
  OrderStatus.DISPATCHING,
  OrderStatus.ASSIGNED,
  OrderStatus.EN_ROUTE,
  OrderStatus.ARRIVED,
  OrderStatus.IN_SERVICE,
  OrderStatus.AWAITING_CONFIRMATION,
];

@Injectable()
export class OperationsDashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
  ) {}

  async get(
    principal: AuthPrincipal,
    organizationId: string,
    now = new Date(),
  ): Promise<OperationsDashboard> {
    this.access.assertPermission(principal, "orders.read", organizationId);
    const { start, end, day } = this.shanghaiDay(now);

    const [
      todayOrders,
      activeOrders,
      paidToday,
      expiredPayments,
      paymentAttention,
      refundAttention,
      safetyAttention,
      recentOrders,
    ] = await Promise.all([
      this.prisma.order.count({
        where: { organizationId, appointmentStart: { gte: start, lt: end } },
      }),
      this.prisma.order.count({
        where: { organizationId, status: { in: ACTIVE_ORDER_STATUSES } },
      }),
      this.prisma.payment.aggregate({
        where: {
          status: {
            in: [
              PaymentStatus.SUCCEEDED,
              PaymentStatus.REFUNDING,
              PaymentStatus.REFUNDED,
            ],
          },
          succeededAt: { gte: start, lt: end },
          order: { organizationId },
        },
        _sum: { amountFen: true },
      }),
      this.prisma.order.count({
        where: {
          organizationId,
          status: OrderStatus.PENDING_PAYMENT,
          paymentExpiresAt: { lt: now },
          OR: [
            { payment: { is: null } },
            { payment: { is: { recoveryReviewAt: null } } },
          ],
        },
      }),
      this.prisma.payment.count({
        where: {
          order: { organizationId },
          OR: [
            {
              status: {
                in: [PaymentStatus.SUCCEEDED, PaymentStatus.REFUNDING],
              },
              failureCode: "FULFILLMENT_REVIEW_REQUIRED",
              refundedFen: { lt: this.prisma.payment.fields.amountFen },
            },
            { status: PaymentStatus.PENDING, recoveryReviewAt: { not: null } },
          ],
        },
      }),
      this.prisma.refund.count({
        where: {
          status: { in: [RefundStatus.UNKNOWN, RefundStatus.ABNORMAL] },
          payment: { order: { organizationId } },
        },
      }),
      this.prisma.safetyIncident.count({
        where: {
          organizationId,
          status: {
            in: [SafetyIncidentStatus.OPEN, SafetyIncidentStatus.ESCALATED],
          },
        },
      }),
      this.prisma.order.findMany({
        where: { organizationId, createdAt: { gte: start, lt: end } },
        include: {
          customer: { select: { displayName: true } },
          therapist: { select: { displayName: true } },
          items: { select: { serviceName: true }, take: 1 },
        },
        orderBy: { createdAt: "desc" },
        take: 10,
      }),
    ]);

    return {
      day,
      timeZone: "Asia/Shanghai",
      generatedAt: now.toISOString(),
      metrics: {
        todayOrders,
        activeOrders,
        paidTodayFen: this.safeMoney(paidToday._sum.amountFen ?? 0n),
        attentionRequired:
          expiredPayments +
          paymentAttention +
          refundAttention +
          safetyAttention,
      },
      recentOrders: recentOrders.map((order) => ({
        id: order.id,
        orderNo: order.orderNo,
        customerName: order.customer.displayName,
        serviceName: order.items[0]?.serviceName ?? "服务快照缺失",
        appointmentStart: order.appointmentStart.toISOString(),
        therapistName: order.therapist?.displayName ?? null,
        status: order.status,
        payableFen: this.safeMoney(order.payableFen),
      })),
    };
  }

  private shanghaiDay(now: Date) {
    const offsetMs = 8 * 60 * 60 * 1_000;
    const local = new Date(now.getTime() + offsetMs);
    const start = new Date(
      Date.UTC(
        local.getUTCFullYear(),
        local.getUTCMonth(),
        local.getUTCDate(),
      ) - offsetMs,
    );
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1_000);
    return { start, end, day: local.toISOString().slice(0, 10) };
  }

  private safeMoney(value: bigint) {
    const money = Number(value);
    if (!Number.isSafeInteger(money)) {
      throw new InternalServerErrorException("经营汇总金额超出安全范围");
    }
    return money;
  }
}
