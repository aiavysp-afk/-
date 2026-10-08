import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { OrderStatus, UserRole } from "@prisma/client";
import type {
  TechnicianEarnings,
  TechnicianOrderAction,
  TechnicianOrderActionResult,
  TechnicianLocationReport,
  TechnicianLocationReportResult,
  TechnicianRoute,
  TechnicianWorkbench,
} from "@zydj/contracts";
import { createHash } from "node:crypto";
import { AccessControlService } from "../auth/access-control.service.js";
import { AuthCryptoService } from "../auth/auth-crypto.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { PrismaService } from "../database/prisma.service.js";
import { AmapClient } from "../integrations/amap.client.js";
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
  Exclude<TechnicianOrderAction["action"], "ACCEPT">,
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
    @Optional() private readonly maps?: AmapClient,
    @Optional() private readonly crypto?: AuthCryptoService,
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
          OR: [
            { appointmentStart: { gte: start, lt: end } },
            {
              status: { in: ACTIVE_ORDER_STATUSES },
              appointmentEnd: { gt: now },
            },
          ],
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

    const todayOrders = orders.filter(
      (order) =>
        order.appointmentStart >= start && order.appointmentStart < end,
    );
    return {
      displayName: principal.displayName,
      day,
      timeZone: "Asia/Shanghai",
      generatedAt: now.toISOString(),
      metrics: {
        todayOrders: todayOrders.length,
        activeOrders: todayOrders.filter((order) =>
          ACTIVE_ORDER_STATUSES.includes(order.status),
        ).length,
        completedOrders: todayOrders.filter(
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
          destination: this.destination(order),
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
          appointmentEnd: true,
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

      if (input.action === "ACCEPT") {
        if (order.status === OrderStatus.ASSIGNED) {
          return {
            orderId: order.id,
            action: input.action,
            previousStatus: OrderStatus.PAID,
            status: OrderStatus.ASSIGNED,
            idempotentReplay: true,
          };
        }
        if (
          order.appointmentEnd <= now ||
          (order.status !== OrderStatus.PAID &&
            order.status !== OrderStatus.DISPATCHING)
        ) {
          throw new ConflictException("当前预约不可接单，请刷新工作台");
        }
        const previousStatus = order.status;
        let currentStatus: OrderStatus = order.status;
        if (currentStatus === OrderStatus.PAID) {
          const dispatching = this.stateMachine.transition(
            currentStatus,
            "DISPATCH_STARTED",
          );
          const started = await tx.order.updateMany({
            where: {
              id: order.id,
              therapistId: principal.userId,
              status: currentStatus,
            },
            data: { status: dispatching },
          });
          if (started.count !== 1)
            throw new ConflictException("订单接单状态已变化");
          await tx.orderEvent.create({
            data: {
              orderId: order.id,
              type: "DISPATCH_STARTED",
              actorId: principal.userId,
              payload: { source: "TECHNICIAN_WORKBENCH" },
            },
          });
          currentStatus = dispatching;
        }
        const assigned = this.stateMachine.transition(
          currentStatus,
          "THERAPIST_ASSIGNED",
        );
        const accepted = await tx.order.updateMany({
          where: {
            id: order.id,
            therapistId: principal.userId,
            status: currentStatus,
          },
          data: { status: assigned },
        });
        if (accepted.count !== 1)
          throw new ConflictException("订单接单状态已变化");
        await tx.orderEvent.create({
          data: {
            orderId: order.id,
            type: "THERAPIST_ASSIGNED",
            actorId: principal.userId,
            payload: { source: "TECHNICIAN_ACCEPTED" },
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: principal.userId,
            organizationId: order.organizationId,
            action: "ORDER_TECHNICIAN_ACCEPTED",
            resourceType: "Order",
            resourceId: order.id,
            metadata: {},
          },
        });
        await tx.outboxEvent.create({
          data: {
            aggregateId: order.id,
            type: "ORDER_TECHNICIAN_ACCEPTED",
            payload: { orderId: order.id, therapistId: principal.userId },
          },
        });
        return {
          orderId: order.id,
          action: input.action,
          previousStatus,
          status: assigned,
          idempotentReplay: false,
        };
      }

      const action = ACTIONS[input.action];

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

  async reportLocation(
    principal: AuthPrincipal,
    input: TechnicianLocationReport,
    now = new Date(),
  ): Promise<TechnicianLocationReportResult> {
    const organizationIds = this.therapistOrganizations(principal);
    for (const organizationId of organizationIds)
      this.access.assertPermission(principal, "orders.read", organizationId);
    const location = await this.prisma.technicianLocation.upsert({
      where: { technicianId: principal.userId },
      create: {
        technicianId: principal.userId,
        latitude: input.latitude,
        longitude: input.longitude,
        coordinateSystem: "GCJ-02",
        accuracyMeters: input.accuracyMeters,
        reportedAt: now,
      },
      update: {
        latitude: input.latitude,
        longitude: input.longitude,
        coordinateSystem: "GCJ-02",
        accuracyMeters: input.accuracyMeters,
        reportedAt: now,
      },
    });
    return {
      latitude: location.latitude,
      longitude: location.longitude,
      coordinateSystem: "GCJ-02",
      ...(location.accuracyMeters === null
        ? {}
        : { accuracyMeters: location.accuracyMeters }),
      reportedAt: location.reportedAt.toISOString(),
    };
  }

  async route(
    principal: AuthPrincipal,
    orderId: string,
    now = new Date(),
  ): Promise<TechnicianRoute> {
    this.therapistOrganizations(principal);
    if (!this.maps)
      throw new ServiceUnavailableException("高德路线服务尚未就绪");
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        organizationId: true,
        therapistId: true,
        status: true,
        addressEncrypted: true,
        addressLatitude: true,
        addressLongitude: true,
        addressCoordinateSystem: true,
      },
    });
    if (!order) throw new NotFoundException("履约订单不存在");
    if (order.therapistId !== principal.userId)
      throw new ForbiddenException("不能计算未指派给本人的订单路线");
    this.access.assertPermission(
      principal,
      "orders.read",
      order.organizationId,
    );
    if (
      order.status !== OrderStatus.ASSIGNED &&
      order.status !== OrderStatus.EN_ROUTE &&
      order.status !== OrderStatus.ARRIVED
    )
      throw new ConflictException("当前订单状态不允许计算驾车路线");
    const destination = this.destination(order);
    if (!destination)
      throw new ConflictException("该订单没有可用的 GCJ-02 上门坐标");
    const current = await this.prisma.technicianLocation.findUnique({
      where: { technicianId: principal.userId },
    });
    if (!current || now.getTime() - current.reportedAt.getTime() > 5 * 60_000)
      throw new ConflictException("请先上报当前位置，再计算驾车路线");
    await this.takeRouteBudget(principal.userId, now);
    const origin = {
      latitude: current.latitude,
      longitude: current.longitude,
      coordinateSystem: "GCJ-02" as const,
    };
    const result = await this.maps.driving({ origin, destination });
    return { orderId: order.id, ...result, origin, destination };
  }

  private async takeRouteBudget(userId: string, now: Date) {
    const windowMs = 60_000;
    const bucket = Math.floor(now.getTime() / windowMs);
    const key = createHash("sha256")
      .update(`map:technician-route:${userId}:${bucket}`)
      .digest("hex");
    const row = await this.prisma.mapRequestRateLimit.upsert({
      where: { key },
      create: { key, count: 1, expiresAt: new Date((bucket + 2) * windowMs) },
      update: { count: { increment: 1 } },
    });
    if (row.count > 10)
      throw new HttpException("路线计算过于频繁，请稍后重试", 429);
  }

  private therapistOrganizations(principal: AuthPrincipal) {
    const ids = principal.memberships
      .filter((membership) => membership.role === UserRole.THERAPIST)
      .map((membership) => membership.organizationId);
    if (!ids.length) throw new ForbiddenException("当前身份不是已授权技师");
    return ids;
  }

  private destination(order: {
    addressEncrypted?: string;
    addressLatitude?: number | null;
    addressLongitude?: number | null;
    addressCoordinateSystem?: string | null;
  }) {
    if (
      !this.crypto ||
      order.addressLatitude === null ||
      order.addressLatitude === undefined ||
      order.addressLongitude === null ||
      order.addressLongitude === undefined ||
      order.addressCoordinateSystem !== "GCJ-02" ||
      !order.addressEncrypted
    )
      return null;
    try {
      const parsed = JSON.parse(
        this.crypto.decrypt(order.addressEncrypted),
      ) as {
        detail?: unknown;
      };
      if (typeof parsed.detail !== "string" || parsed.detail.length < 5)
        return null;
      return {
        latitude: order.addressLatitude,
        longitude: order.addressLongitude,
        coordinateSystem: "GCJ-02" as const,
        addressLabel: parsed.detail.slice(0, 200),
      };
    } catch {
      throw new InternalServerErrorException("订单地址无法解密");
    }
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
