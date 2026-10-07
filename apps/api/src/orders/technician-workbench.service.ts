import {
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { OrderStatus, UserRole } from "@prisma/client";
import type {
  TechnicianEarnings,
  TechnicianOrderAction,
  TechnicianOrderActionResult,
  TechnicianWorkbench,
} from "@zydj/contracts";
import { AccessControlService } from "../auth/access-control.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { PrismaService } from "../database/prisma.service.js";
import {
  OrderStateMachine,
  type OrderTransitionEvent,
} from "./order-state-machine.js";

const ACTIVE_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.PAID,
  OrderStatus.DISPATCHING,
  OrderStatus.ASSIGNED,
  OrderStatus.EN_ROUTE,
  OrderStatus.ARRIVED,
  OrderStatus.IN_SERVICE,
  OrderStatus.AWAITING_CONFIRMATION,
];

const ACTIONS: Record<
  TechnicianOrderAction["action"],
  {
    expected: OrderStatus;
    event: OrderTransitionEvent;
    target: OrderStatus;
  }
> = {
  DEPART: {
    expected: OrderStatus.ASSIGNED,
    event: "THERAPIST_EN_ROUTE",
    target: OrderStatus.EN_ROUTE,
  },
  ARRIVE: {
    expected: OrderStatus.EN_ROUTE,
    event: "THERAPIST_ARRIVED",
    target: OrderStatus.ARRIVED,
  },
  START_SERVICE: {
    expected: OrderStatus.ARRIVED,
    event: "SERVICE_STARTED",
    target: OrderStatus.IN_SERVICE,
  },
  FINISH_SERVICE: {
    expected: OrderStatus.IN_SERVICE,
    event: "SERVICE_AWAITING_CONFIRMATION",
    target: OrderStatus.AWAITING_CONFIRMATION,
  },
};

@Injectable()
export class TechnicianWorkbenchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly stateMachine: OrderStateMachine,
  ) {}

  async get(
    principal: AuthPrincipal,
    now = new Date(),
  ): Promise<TechnicianWorkbench> {
    const organizationIds = principal.memberships
      .filter((membership) => membership.role === UserRole.THERAPIST)
      .map((membership) => membership.organizationId);
    if (!organizationIds.length) {
      throw new ForbiddenException("当前身份不是已授权技师");
    }
    for (const organizationId of organizationIds) {
      this.access.assertPermission(principal, "orders.read", organizationId);
    }

    const { start, end, weekStart, weekEnd, day } = this.shanghaiPeriods(now);
    const [orders, weeklyShifts] = await Promise.all([
      this.prisma.order.findMany({
        where: {
          organizationId: { in: organizationIds },
          therapistId: principal.userId,
          appointmentStart: { gte: start, lt: end },
        },
        include: {
          items: {
            select: { serviceName: true, durationMinutes: true },
            take: 1,
          },
        },
        orderBy: { appointmentStart: "asc" },
      }),
      this.prisma.therapistShift.findMany({
        where: {
          organizationId: { in: organizationIds },
          therapistId: principal.userId,
          status: "ACTIVE",
          startsAt: { lt: weekEnd },
          endsAt: { gt: weekStart },
        },
        select: {
          id: true,
          startsAt: true,
          endsAt: true,
          status: true,
        },
        orderBy: { startsAt: "asc" },
      }),
    ]);

    return {
      displayName: principal.displayName,
      day,
      timeZone: "Asia/Shanghai",
      generatedAt: now.toISOString(),
      metrics: {
        todayOrders: orders.length,
        activeOrders: orders.filter((order) =>
          ACTIVE_ORDER_STATUSES.includes(order.status),
        ).length,
        completedOrders: orders.filter(
          (order) => order.status === OrderStatus.COMPLETED,
        ).length,
        weeklyShifts: weeklyShifts.length,
      },
      orders: orders.map((order) => {
        const item = order.items[0];
        if (!item) {
          throw new InternalServerErrorException("订单服务快照不完整");
        }
        return {
          id: order.id,
          orderNo: order.orderNo,
          serviceName: item.serviceName,
          durationMinutes: item.durationMinutes,
          appointmentStart: order.appointmentStart.toISOString(),
          appointmentEnd: order.appointmentEnd.toISOString(),
          status: order.status,
        };
      }),
      shifts: weeklyShifts.map((shift) => ({
        id: shift.id,
        startsAt: shift.startsAt.toISOString(),
        endsAt: shift.endsAt.toISOString(),
        status: shift.status,
      })),
    };
  }

  async getEarnings(
    principal: AuthPrincipal,
    now = new Date(),
  ): Promise<TechnicianEarnings> {
    const organizationIds = principal.memberships
      .filter((membership) => membership.role === UserRole.THERAPIST)
      .map((membership) => membership.organizationId);
    if (!organizationIds.length) {
      throw new ForbiddenException("当前身份不是已授权技师");
    }
    for (const organizationId of organizationIds) {
      this.access.assertPermission(principal, "orders.read", organizationId);
    }

    const { start, end } = this.shanghaiMonth(now);
    const where = {
      organizationId: { in: organizationIds },
      therapistId: principal.userId,
      status: OrderStatus.COMPLETED,
      events: {
        some: {
          type: "CUSTOMER_CONFIRMED",
          createdAt: { gte: start, lt: end },
        },
      },
    };
    const [summary, orders] = await Promise.all([
      this.prisma.order.aggregate({
        where,
        _count: { _all: true },
        _sum: { payableFen: true },
      }),
      this.prisma.order.findMany({
        where,
        select: {
          id: true,
          orderNo: true,
          payableFen: true,
          items: {
            select: { serviceName: true },
            take: 1,
          },
          events: {
            where: {
              type: "CUSTOMER_CONFIRMED",
              createdAt: { gte: start, lt: end },
            },
            select: { createdAt: true },
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
        orderBy: { updatedAt: "desc" },
        take: 100,
      }),
    ]);

    return {
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
      timeZone: "Asia/Shanghai",
      generatedAt: now.toISOString(),
      metrics: {
        completedOrders: summary._count._all,
        grossOrderAmountFen: this.safeMoney(summary._sum.payableFen ?? 0n),
      },
      settlement: {
        status: "POLICY_NOT_CONFIGURED",
        payableFen: null,
        notice:
          "当前仅展示已完成订单流水；佣金、平台费、退款扣回和打款规则尚未配置，不能作为可提现收入。",
      },
      items: orders.map((order) => {
        const item = order.items[0];
        const confirmation = order.events[0];
        if (!item || !confirmation) {
          throw new InternalServerErrorException("完成订单流水资料不完整");
        }
        return {
          orderId: order.id,
          orderNo: order.orderNo,
          serviceName: item.serviceName,
          completedAt: confirmation.createdAt.toISOString(),
          grossOrderAmountFen: this.safeMoney(order.payableFen),
        };
      }),
    };
  }

  async advance(
    principal: AuthPrincipal,
    orderId: string,
    input: TechnicianOrderAction,
    now = new Date(),
  ): Promise<TechnicianOrderActionResult> {
    const action = ACTIONS[input.action];
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          organizationId: true,
          therapistId: true,
          status: true,
          appointmentStart: true,
        },
      });
      if (!order) throw new NotFoundException("履约订单不存在");

      const isTherapist = principal.memberships.some(
        (membership) =>
          membership.organizationId === order.organizationId &&
          membership.role === UserRole.THERAPIST,
      );
      if (!isTherapist || order.therapistId !== principal.userId) {
        throw new ForbiddenException("不能操作未指派给本人的订单");
      }
      this.access.assertPermission(
        principal,
        "orders.read",
        order.organizationId,
      );

      const { start, end } = this.shanghaiPeriods(now);
      if (order.appointmentStart < start || order.appointmentStart >= end) {
        throw new ConflictException("只能操作今日安排的订单");
      }

      if (order.status === action.target) {
        return {
          orderId: order.id,
          action: input.action,
          previousStatus: action.expected,
          status: action.target,
          idempotentReplay: true,
        };
      }
      if (order.status !== action.expected) {
        this.stateMachine.transition(order.status, action.event);
      }
      const next = this.stateMachine.transition(order.status, action.event);
      const updated = await tx.order.updateMany({
        where: {
          id: order.id,
          therapistId: principal.userId,
          status: order.status,
        },
        data: { status: next },
      });
      if (updated.count !== 1) {
        throw new ConflictException("订单履约状态已变化");
      }
      await tx.orderEvent.create({
        data: {
          orderId: order.id,
          type: action.event,
          actorId: principal.userId,
          payload: {},
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId: order.organizationId,
          action: action.event,
          resourceType: "Order",
          resourceId: order.id,
          metadata: {},
        },
      });
      await tx.outboxEvent.create({
        data: {
          aggregateId: order.id,
          type: "ORDER_STATUS_CHANGED",
          payload: { orderId: order.id, status: next },
        },
      });
      return {
        orderId: order.id,
        action: input.action,
        previousStatus: order.status,
        status: next,
        idempotentReplay: false,
      };
    });
  }

  private shanghaiPeriods(now: Date) {
    const dayMs = 24 * 60 * 60 * 1_000;
    const offsetMs = 8 * 60 * 60 * 1_000;
    const local = new Date(now.getTime() + offsetMs);
    const start = new Date(
      Date.UTC(
        local.getUTCFullYear(),
        local.getUTCMonth(),
        local.getUTCDate(),
      ) - offsetMs,
    );
    const end = new Date(start.getTime() + dayMs);
    const mondayOffset = (local.getUTCDay() + 6) % 7;
    const weekStart = new Date(start.getTime() - mondayOffset * dayMs);
    const weekEnd = new Date(weekStart.getTime() + 7 * dayMs);
    return {
      start,
      end,
      weekStart,
      weekEnd,
      day: local.toISOString().slice(0, 10),
    };
  }

  private shanghaiMonth(now: Date) {
    const offsetMs = 8 * 60 * 60 * 1_000;
    const local = new Date(now.getTime() + offsetMs);
    const start = new Date(
      Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - offsetMs,
    );
    const end = new Date(
      Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) - offsetMs,
    );
    return { start, end };
  }

  private safeMoney(value: bigint) {
    const money = Number(value);
    if (!Number.isSafeInteger(money) || money < 0) {
      throw new InternalServerErrorException("订单流水金额超出安全范围");
    }
    return money;
  }
}
