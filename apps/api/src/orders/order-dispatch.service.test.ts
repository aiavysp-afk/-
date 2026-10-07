import { ConflictException } from "@nestjs/common";
import { OrderStatus, UserRole } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { OrderDispatchService } from "./order-dispatch.service.js";
import { OrderStateMachine } from "./order-state-machine.js";

const dispatcher: AuthPrincipal = {
  sessionId: "session-dispatcher",
  userId: "dispatcher-1",
  displayName: "调度员",
  memberships: [{ organizationId: "org-1", role: UserRole.DISPATCHER }],
};

function assignmentFixture(status: OrderStatus = OrderStatus.PAID) {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    order: {
      findUnique: vi.fn().mockResolvedValue({
        id: "order-1",
        organizationId: "org-1",
        status,
        therapistId: "therapist-1",
        reservationId: "reservation-1",
        appointmentStart: new Date("2026-10-08T02:00:00.000Z"),
        appointmentEnd: new Date("2026-10-08T03:00:00.000Z"),
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    staffMembership: {
      findFirst: vi.fn().mockResolvedValue({
        userId: "therapist-1",
        user: { id: "therapist-1", displayName: "安然" },
      }),
    },
    therapistShift: { findFirst: vi.fn().mockResolvedValue({ id: "shift-1" }) },
    appointmentReservation: {
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
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
  return {
    tx,
    access,
    service: new OrderDispatchService(
      prisma as never,
      access as never,
      new OrderStateMachine(),
    ),
  };
}

describe("OrderDispatchService", () => {
  it("returns a real dispatch board without customer address or phone", async () => {
    const prisma = {
      order: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "order-1",
            orderNo: "ZY202610070001",
            status: OrderStatus.PAID,
            appointmentStart: new Date("2026-10-08T02:00:00.000Z"),
            appointmentEnd: new Date("2026-10-08T03:00:00.000Z"),
            payableFen: 29_800n,
            customer: { displayName: "顾客" },
            therapist: { id: "therapist-1", displayName: "安然" },
            items: [{ serviceName: "肩颈舒缓", durationMinutes: 60 }],
          },
        ]),
      },
      staffMembership: {
        findMany: vi.fn().mockResolvedValue([
          {
            userId: "therapist-1",
            user: { id: "therapist-1", displayName: "安然" },
          },
        ]),
      },
      therapistShift: {
        findMany: vi.fn().mockResolvedValue([
          {
            therapistId: "therapist-1",
            startsAt: new Date("2026-10-08T01:00:00.000Z"),
            endsAt: new Date("2026-10-08T04:00:00.000Z"),
          },
        ]),
      },
    };
    const access = { assertPermission: vi.fn() };
    const service = new OrderDispatchService(
      prisma as never,
      access as never,
      new OrderStateMachine(),
    );

    const result = await service.getBoard(
      dispatcher,
      "org-1",
      new Date("2026-10-07T08:00:00.000Z"),
    );

    expect(access.assertPermission).toHaveBeenCalledWith(
      dispatcher,
      "orders.dispatch",
      "org-1",
    );
    expect(result.orders[0]).toMatchObject({
      orderNo: "ZY202610070001",
      payableFen: 29_800,
      eligibleTherapists: [{ id: "therapist-1", displayName: "安然" }],
    });
    expect(result.orders[0]).not.toHaveProperty("address");
    expect(result.orders[0]).not.toHaveProperty("phone");
  });

  it("moves a paid order through dispatching to assigned under one lock", async () => {
    const { service, tx, access } = assignmentFixture();

    const result = await service.assign(
      dispatcher,
      "org-1",
      "order-1",
      { therapistId: "therapist-1" },
      new Date("2026-10-07T08:00:00.000Z"),
    );

    expect(access.assertPermission).toHaveBeenCalledWith(
      dispatcher,
      "orders.dispatch",
      "org-1",
    );
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(tx.order.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: "order-1", status: OrderStatus.PAID },
      data: { status: OrderStatus.DISPATCHING },
    });
    expect(tx.order.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: "order-1", status: OrderStatus.DISPATCHING },
      data: { status: OrderStatus.ASSIGNED, therapistId: "therapist-1" },
    });
    expect(tx.orderEvent.create).toHaveBeenCalledTimes(2);
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
    expect(result).toEqual({
      orderId: "order-1",
      status: "ASSIGNED",
      therapist: { id: "therapist-1", displayName: "安然" },
    });
  });

  it("rejects a therapist with an overlapping confirmed reservation", async () => {
    const { service, tx } = assignmentFixture();
    tx.appointmentReservation.findFirst.mockResolvedValueOnce({
      id: "reservation-conflict",
    });

    await expect(
      service.assign(
        dispatcher,
        "org-1",
        "order-1",
        { therapistId: "therapist-1" },
        new Date("2026-10-07T08:00:00.000Z"),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.order.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("treats a repeated assignment to the same therapist as idempotent", async () => {
    const { service, tx } = assignmentFixture(OrderStatus.ASSIGNED);

    const result = await service.assign(
      dispatcher,
      "org-1",
      "order-1",
      { therapistId: "therapist-1" },
      new Date("2026-10-07T08:00:00.000Z"),
    );

    expect(result.status).toBe("ASSIGNED");
    expect(tx.therapistShift.findFirst).not.toHaveBeenCalled();
    expect(tx.order.updateMany).not.toHaveBeenCalled();
  });

  it("rejects dispatch after the appointment has ended", async () => {
    const { service, tx } = assignmentFixture();

    await expect(
      service.assign(
        dispatcher,
        "org-1",
        "order-1",
        { therapistId: "therapist-1" },
        new Date("2026-10-08T03:00:00.000Z"),
      ),
    ).rejects.toThrow("预约时间已结束");
    expect(tx.therapistShift.findFirst).not.toHaveBeenCalled();
    expect(tx.order.updateMany).not.toHaveBeenCalled();
  });
});
