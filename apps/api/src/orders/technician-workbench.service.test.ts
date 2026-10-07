import { ConflictException, ForbiddenException } from "@nestjs/common";
import { OrderStatus, UserRole } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { TechnicianWorkbenchService } from "./technician-workbench.service.js";
import { OrderStateMachine } from "./order-state-machine.js";

const therapist: AuthPrincipal = {
  sessionId: "session-therapist",
  userId: "therapist-1",
  displayName: "安然",
  memberships: [{ organizationId: "org-1", role: UserRole.THERAPIST }],
};

describe("TechnicianWorkbenchService", () => {
  it("returns only the authenticated therapist's real schedule summary", async () => {
    const prisma = {
      order: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "order-1",
            orderNo: "ZY202610070001",
            status: OrderStatus.ASSIGNED,
            appointmentStart: new Date("2026-10-07T06:00:00.000Z"),
            appointmentEnd: new Date("2026-10-07T07:00:00.000Z"),
            items: [{ serviceName: "肩颈舒缓", durationMinutes: 60 }],
          },
          {
            id: "order-2",
            orderNo: "ZY202610070002",
            status: OrderStatus.COMPLETED,
            appointmentStart: new Date("2026-10-07T02:00:00.000Z"),
            appointmentEnd: new Date("2026-10-07T03:00:00.000Z"),
            items: [{ serviceName: "足部舒缓", durationMinutes: 60 }],
          },
        ]),
      },
      therapistShift: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "shift-1",
            startsAt: new Date("2026-10-07T01:00:00.000Z"),
            endsAt: new Date("2026-10-07T10:00:00.000Z"),
            status: "ACTIVE",
          },
          {
            id: "shift-2",
            startsAt: new Date("2026-10-09T01:00:00.000Z"),
            endsAt: new Date("2026-10-09T10:00:00.000Z"),
            status: "ACTIVE",
          },
        ]),
      },
    };
    const access = { assertPermission: vi.fn() };
    const service = new TechnicianWorkbenchService(
      prisma as never,
      access as never,
      new OrderStateMachine(),
    );

    const result = await service.get(
      therapist,
      new Date("2026-10-07T08:00:00.000Z"),
    );

    expect(access.assertPermission).toHaveBeenCalledWith(
      therapist,
      "orders.read",
      "org-1",
    );
    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: { in: ["org-1"] },
          therapistId: "therapist-1",
        }),
      }),
    );
    expect(result).toMatchObject({
      displayName: "安然",
      day: "2026-10-07",
      metrics: {
        todayOrders: 2,
        activeOrders: 1,
        completedOrders: 1,
        weeklyShifts: 2,
      },
      shifts: [
        {
          id: "shift-1",
          startsAt: "2026-10-07T01:00:00.000Z",
          endsAt: "2026-10-07T10:00:00.000Z",
          status: "ACTIVE",
        },
        {
          id: "shift-2",
          startsAt: "2026-10-09T01:00:00.000Z",
          endsAt: "2026-10-09T10:00:00.000Z",
          status: "ACTIVE",
        },
      ],
    });
    expect(prisma.therapistShift.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          therapistId: "therapist-1",
          status: "ACTIVE",
        }),
        orderBy: { startsAt: "asc" },
      }),
    );
    expect(result.orders[0]).not.toHaveProperty("customerName");
    expect(result.orders[0]).not.toHaveProperty("address");
  });

  it("returns this month's completed-order gross flow without inventing a payable income", async () => {
    const prisma = {
      order: {
        aggregate: vi.fn().mockResolvedValue({
          _count: { _all: 2 },
          _sum: { payableFen: 49_600n },
        }),
        findMany: vi.fn().mockResolvedValue([
          {
            id: "order-income-1",
            orderNo: "ZY202610070099",
            payableFen: 19_800n,
            items: [{ serviceName: "肩颈舒缓" }],
            events: [{ createdAt: new Date("2026-10-07T06:30:00.000Z") }],
          },
        ]),
      },
    };
    const access = { assertPermission: vi.fn() };
    const service = new TechnicianWorkbenchService(
      prisma as never,
      access as never,
      new OrderStateMachine(),
    );

    const result = await service.getEarnings(
      therapist,
      new Date("2026-10-07T08:00:00.000Z"),
    );

    expect(result).toMatchObject({
      periodStart: "2026-09-30T16:00:00.000Z",
      periodEnd: "2026-10-31T16:00:00.000Z",
      metrics: {
        completedOrders: 2,
        grossOrderAmountFen: 49_600,
      },
      settlement: {
        status: "POLICY_NOT_CONFIGURED",
        payableFen: null,
      },
      items: [
        {
          orderId: "order-income-1",
          grossOrderAmountFen: 19_800,
          completedAt: "2026-10-07T06:30:00.000Z",
        },
      ],
    });
    expect(result.items[0]).not.toHaveProperty("customerName");
    expect(result.items[0]).not.toHaveProperty("address");
    expect(prisma.order.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          therapistId: therapist.userId,
          status: OrderStatus.COMPLETED,
          events: {
            some: expect.objectContaining({ type: "CUSTOMER_CONFIRMED" }),
          },
        }),
      }),
    );
  });

  it("rejects a principal without an active therapist membership", async () => {
    const service = new TechnicianWorkbenchService(
      {} as never,
      { assertPermission: vi.fn() } as never,
      new OrderStateMachine(),
    );
    await expect(
      service.get({ ...therapist, memberships: [] }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("advances the assigned therapist order under a row lock and audit trail", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      order: {
        findUnique: vi.fn().mockResolvedValue({
          id: "order-1",
          organizationId: "org-1",
          therapistId: "therapist-1",
          status: OrderStatus.ASSIGNED,
          appointmentStart: new Date("2026-10-07T06:00:00.000Z"),
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      orderEvent: { create: vi.fn().mockResolvedValue({}) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      outboxEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) =>
        operation(tx),
      ),
    };
    const access = { assertPermission: vi.fn() };
    const service = new TechnicianWorkbenchService(
      prisma as never,
      access as never,
      new OrderStateMachine(),
    );

    const result = await service.advance(
      therapist,
      "order-1",
      { action: "DEPART" },
      new Date("2026-10-07T05:00:00.000Z"),
    );

    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(access.assertPermission).toHaveBeenCalledWith(
      therapist,
      "orders.read",
      "org-1",
    );
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: {
        id: "order-1",
        therapistId: "therapist-1",
        status: OrderStatus.ASSIGNED,
      },
      data: { status: OrderStatus.EN_ROUTE },
    });
    expect(tx.orderEvent.create).toHaveBeenCalledOnce();
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
    expect(tx.outboxEvent.create).toHaveBeenCalledOnce();
    expect(result).toEqual({
      orderId: "order-1",
      action: "DEPART",
      previousStatus: OrderStatus.ASSIGNED,
      status: OrderStatus.EN_ROUTE,
      idempotentReplay: false,
    });
  });

  it("makes an immediately repeated action idempotent", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      order: {
        findUnique: vi.fn().mockResolvedValue({
          id: "order-1",
          organizationId: "org-1",
          therapistId: "therapist-1",
          status: OrderStatus.EN_ROUTE,
          appointmentStart: new Date("2026-10-07T06:00:00.000Z"),
        }),
        updateMany: vi.fn(),
      },
      orderEvent: { create: vi.fn() },
      auditLog: { create: vi.fn() },
      outboxEvent: { create: vi.fn() },
    };
    const service = new TechnicianWorkbenchService(
      {
        $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) =>
          operation(tx),
        ),
      } as never,
      { assertPermission: vi.fn() } as never,
      new OrderStateMachine(),
    );

    const result = await service.advance(
      therapist,
      "order-1",
      { action: "DEPART" },
      new Date("2026-10-07T05:00:00.000Z"),
    );

    expect(result.idempotentReplay).toBe(true);
    expect(tx.order.updateMany).not.toHaveBeenCalled();
    expect(tx.orderEvent.create).not.toHaveBeenCalled();
  });

  it("rejects another technician and a non-today order", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      order: {
        findUnique: vi.fn().mockResolvedValue({
          id: "order-1",
          organizationId: "org-1",
          therapistId: "therapist-other",
          status: OrderStatus.ASSIGNED,
          appointmentStart: new Date("2026-10-08T06:00:00.000Z"),
        }),
        updateMany: vi.fn(),
      },
    };
    const service = new TechnicianWorkbenchService(
      {
        $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) =>
          operation(tx),
        ),
      } as never,
      { assertPermission: vi.fn() } as never,
      new OrderStateMachine(),
    );

    await expect(
      service.advance(
        therapist,
        "order-1",
        { action: "DEPART" },
        new Date("2026-10-07T05:00:00.000Z"),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    tx.order.findUnique.mockResolvedValueOnce({
      id: "order-1",
      organizationId: "org-1",
      therapistId: "therapist-1",
      status: OrderStatus.ASSIGNED,
      appointmentStart: new Date("2026-10-08T06:00:00.000Z"),
    });
    await expect(
      service.advance(
        therapist,
        "order-1",
        { action: "DEPART" },
        new Date("2026-10-07T05:00:00.000Z"),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.order.updateMany).not.toHaveBeenCalled();
  });
});
