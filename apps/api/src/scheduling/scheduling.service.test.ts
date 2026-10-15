import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import { ReservationStatus, ShiftStatus, UserRole } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessControlService } from "../auth/access-control.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { SchedulingService } from "./scheduling.service.js";

const dispatcher: AuthPrincipal = {
  sessionId: "session-dispatcher",
  userId: "user-dispatcher",
  displayName: "调度员",
  memberships: [{ organizationId: "org-a", role: UserRole.DISPATCHER }],
};

const customer: AuthPrincipal = {
  sessionId: "session-customer",
  userId: "user-customer",
  displayName: "客户",
  memberships: [],
};

const serviceRecord = {
  id: "svc-neck-60",
  organizationId: "org-a",
  durationMinutes: 60,
};

function expiredOrderFixture(
  current: Record<string, unknown> = {},
  cancelledCount = 1,
) {
  const expiredOrder = {
    id: "expired-order",
    reservationId: "expired-hold",
    status: "PENDING_PAYMENT",
    paymentExpiresAt: new Date("2026-10-02T23:59:00Z"),
    payment: null,
    ...current,
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    appointmentReservation: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          { id: "expired-hold", order: { id: "expired-order" } },
        ]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi
        .fn()
        .mockResolvedValue({
          id: "fresh-hold",
          organizationId: "org-a",
          serviceId: serviceRecord.id,
          therapistId: "therapist-a",
          customerId: customer.userId,
          startsAt: new Date("2026-10-04T02:00:00Z"),
          endsAt: new Date("2026-10-04T03:00:00Z"),
          expiresAt: new Date("2026-10-03T00:10:00Z"),
          status: "HOLD",
        }),
    },
    order: {
      findUniqueOrThrow: vi.fn().mockResolvedValue(expiredOrder),
      updateMany: vi.fn().mockResolvedValue({ count: cancelledCount }),
    },
    customerCoupon: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    orderEvent: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    service: { findFirst: vi.fn().mockResolvedValue(serviceRecord) },
    staffMembership: {
      findFirst: vi.fn().mockResolvedValue({ id: "membership" }),
    },
    therapistShift: { findFirst: vi.fn().mockResolvedValue({ id: "shift" }) },
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  const service = new SchedulingService(
    prisma as never,
    new AccessControlService(),
  );
  return {
    tx,
    create: () =>
      service.createHold(customer, {
        serviceId: serviceRecord.id,
        therapistId: "therapist-a",
        startsAt: "2026-10-04T10:00:00+08:00",
      }),
  };
}

describe("SchedulingService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T00:00:00.000Z"));
  });

  afterEach(() => vi.useRealTimers());

  it("generates aligned slots and removes intervals overlapping an active reservation", async () => {
    const prisma = {
      service: { findFirst: vi.fn().mockResolvedValue(serviceRecord) },
      therapistShift: {
        findMany: vi.fn().mockResolvedValue([
          {
            therapistId: "therapist-a",
            startsAt: new Date("2026-10-04T02:00:00.000Z"),
            endsAt: new Date("2026-10-04T04:00:00.000Z"),
          },
        ]),
      },
      appointmentReservation: {
        findMany: vi.fn().mockResolvedValue([
          {
            therapistId: "therapist-a",
            startsAt: new Date("2026-10-04T03:00:00.000Z"),
            endsAt: new Date("2026-10-04T03:30:00.000Z"),
          },
        ]),
      },
    };
    const scheduling = new SchedulingService(
      prisma as never,
      new AccessControlService(),
    );

    const slots = await scheduling.listAvailability({
      serviceId: "svc-neck-60",
      date: "2026-10-04",
      timeZone: "Asia/Shanghai",
    });

    expect(slots).toEqual([
      {
        therapistId: "therapist-a",
        startsAt: "2026-10-04T02:00:00.000Z",
        endsAt: "2026-10-04T03:00:00.000Z",
      },
    ]);
  });

  it("rejects cross-organization shift creation before database writes", async () => {
    const prisma = { staffMembership: { findFirst: vi.fn() } };
    const scheduling = new SchedulingService(
      prisma as never,
      new AccessControlService(),
    );

    await expect(
      scheduling.createShift(dispatcher, {
        organizationId: "org-b",
        therapistId: "therapist-a",
        startsAt: "2026-10-04T10:00:00+08:00",
        endsAt: "2026-10-04T18:00:00+08:00",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.staffMembership.findFirst).not.toHaveBeenCalled();
  });

  it("returns the earliest real slot first across technicians, with stable same-time ordering", async () => {
    const prisma = {
      service: { findFirst: vi.fn().mockResolvedValue(serviceRecord) },
      therapistShift: {
        findMany: vi.fn().mockResolvedValue([
          {
            therapistId: "therapist-z",
            startsAt: new Date("2026-10-04T00:00:00Z"),
            endsAt: new Date("2026-10-04T06:00:00Z"),
          },
          {
            therapistId: "therapist-b",
            startsAt: new Date("2026-10-04T01:00:00Z"),
            endsAt: new Date("2026-10-04T02:00:00Z"),
          },
          {
            therapistId: "therapist-a",
            startsAt: new Date("2026-10-04T01:00:00Z"),
            endsAt: new Date("2026-10-04T02:00:00Z"),
          },
        ]),
      },
      appointmentReservation: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            {
              therapistId: "therapist-z",
              startsAt: new Date("2026-10-04T00:00:00Z"),
              endsAt: new Date("2026-10-04T04:00:00Z"),
            },
          ]),
      },
    };
    const scheduling = new SchedulingService(
      prisma as never,
      new AccessControlService(),
    );
    const slots = await scheduling.listAvailability({
      serviceId: serviceRecord.id,
      date: "2026-10-04",
      timeZone: "Asia/Shanghai",
    });
    expect(
      slots.map(({ therapistId, startsAt }) => `${startsAt}/${therapistId}`),
    ).toEqual([
      "2026-10-04T01:00:00.000Z/therapist-a",
      "2026-10-04T01:00:00.000Z/therapist-b",
      "2026-10-04T04:00:00.000Z/therapist-z",
      "2026-10-04T04:30:00.000Z/therapist-z",
      "2026-10-04T05:00:00.000Z/therapist-z",
    ]);
  });

  it("creates a ten-minute hold with the service duration and an audit entry", async () => {
    const hold = {
      id: "hold-1",
      organizationId: "org-a",
      serviceId: "svc-neck-60",
      therapistId: "therapist-a",
      customerId: customer.userId,
      startsAt: new Date("2026-10-04T02:00:00.000Z"),
      endsAt: new Date("2026-10-04T03:00:00.000Z"),
      expiresAt: new Date("2026-10-03T00:10:00.000Z"),
      status: ReservationStatus.HOLD,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const tx = {
      appointmentReservation: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn().mockResolvedValue(hold),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      service: { findFirst: vi.fn().mockResolvedValue(serviceRecord) },
      staffMembership: {
        findFirst: vi.fn().mockResolvedValue({ id: "membership-1" }),
      },
      therapistShift: {
        findFirst: vi.fn().mockResolvedValue({ id: "shift-1" }),
      },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    const scheduling = new SchedulingService(
      prisma as never,
      new AccessControlService(),
    );

    await expect(
      scheduling.createHold(customer, {
        serviceId: "svc-neck-60",
        therapistId: "therapist-a",
        startsAt: "2026-10-04T10:00:00+08:00",
      }),
    ).resolves.toMatchObject({
      id: "hold-1",
      endsAt: "2026-10-04T03:00:00.000Z",
      expiresAt: "2026-10-03T00:10:00.000Z",
      status: "HOLD",
    });
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
  });

  it("returns only the cancelled unpaid order's coupon while creating a replacement hold", async () => {
    const f = expiredOrderFixture();
    await f.create();
    expect(f.tx.$queryRaw).toHaveBeenCalledOnce();
    expect(f.tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      f.tx.order.findUniqueOrThrow.mock.invocationCallOrder[0]!,
    );
    expect(f.tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: "expired-order", status: "PENDING_PAYMENT" },
      data: { status: "CANCELLED" },
    });
    const now = new Date("2026-10-03T00:00:00Z");
    expect(f.tx.customerCoupon.updateMany).toHaveBeenCalledWith({
      where: {
        usedOrderId: "expired-order",
        status: "USED",
        expiresAt: { gt: now },
      },
      data: { status: "AVAILABLE", usedOrderId: null, usedAt: null },
    });
    expect(f.tx.customerCoupon.updateMany).toHaveBeenCalledWith({
      where: {
        usedOrderId: "expired-order",
        status: "USED",
        expiresAt: { lte: now },
      },
      data: { status: "EXPIRED", usedOrderId: null, usedAt: null },
    });
    expect(f.tx.orderEvent.createMany).toHaveBeenCalledWith({
      data: [
        { orderId: "expired-order", type: "PAYMENT_EXPIRED", payload: {} },
      ],
    });
    expect(f.tx.appointmentReservation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ["expired-hold"] },
          expiresAt: { lte: now },
        }),
      }),
    );
  });

  it.each([
    { payment: { provider: "WECHAT", status: "PENDING" } },
    { payment: { provider: "WECHAT", status: "SUCCEEDED" } },
    { payment: { provider: "MOCK", status: "SUCCEEDED" } },
    { status: "PAID" },
    { paymentExpiresAt: new Date("2026-10-03T00:10:00Z") },
    { reservationId: "another-hold" },
  ])(
    "does not cancel, release capacity or return coupons if payment wins the expiry scan race: %j",
    async (current) => {
      const f = expiredOrderFixture(current);
      await f.create();
      expect(f.tx.order.updateMany).not.toHaveBeenCalled();
      expect(f.tx.customerCoupon.updateMany).not.toHaveBeenCalled();
      expect(f.tx.orderEvent.createMany).not.toHaveBeenCalled();
      expect(f.tx.appointmentReservation.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: { in: [] } }),
        }),
      );
    },
  );

  it("never returns coupons or emits expiry events for an order that was not actually cancelled", async () => {
    const f = expiredOrderFixture({}, 0);
    await f.create();
    expect(f.tx.customerCoupon.updateMany).not.toHaveBeenCalled();
    expect(f.tx.orderEvent.createMany).not.toHaveBeenCalled();
    expect(f.tx.appointmentReservation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: [] } }),
      }),
    );
  });

  it("maps the PostgreSQL exclusion constraint to a booking conflict", async () => {
    const prisma = {
      service: { findFirst: vi.fn().mockResolvedValue(serviceRecord) },
      staffMembership: {
        findFirst: vi.fn().mockResolvedValue({ id: "membership-1" }),
      },
      therapistShift: {
        findFirst: vi.fn().mockResolvedValue({ id: "shift-1" }),
      },
      $transaction: vi
        .fn()
        .mockRejectedValue(
          new Error("23P01 AppointmentReservation_no_overlap"),
        ),
    };
    const scheduling = new SchedulingService(
      prisma as never,
      new AccessControlService(),
    );

    await expect(
      scheduling.createHold(customer, {
        serviceId: "svc-neck-60",
        therapistId: "therapist-a",
        startsAt: "2026-10-04T10:00:00+08:00",
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("maps the one-active-hold unique index to a customer conflict", async () => {
    const prisma = {
      service: { findFirst: vi.fn().mockResolvedValue(serviceRecord) },
      staffMembership: {
        findFirst: vi.fn().mockResolvedValue({ id: "membership-1" }),
      },
      therapistShift: {
        findFirst: vi.fn().mockResolvedValue({ id: "shift-1" }),
      },
      $transaction: vi.fn().mockRejectedValue({ code: "P2002" }),
    };
    const scheduling = new SchedulingService(
      prisma as never,
      new AccessControlService(),
    );

    await expect(
      scheduling.createHold(customer, {
        serviceId: "svc-neck-60",
        therapistId: "therapist-a",
        startsAt: "2026-10-04T10:00:00+08:00",
      }),
    ).rejects.toThrow("当前账号已有进行中的预约占位");
  });

  it("rejects a hold that is outside an active shift", async () => {
    const prisma = {
      service: { findFirst: vi.fn().mockResolvedValue(serviceRecord) },
      staffMembership: {
        findFirst: vi.fn().mockResolvedValue({ id: "membership-1" }),
      },
      therapistShift: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const scheduling = new SchedulingService(
      prisma as never,
      new AccessControlService(),
    );

    await expect(
      scheduling.createHold(customer, {
        serviceId: "svc-neck-60",
        therapistId: "therapist-a",
        startsAt: "2026-10-04T10:00:00+08:00",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("passes active shift status through the admin response", async () => {
    const tx = {
      therapistShift: {
        create: vi.fn().mockResolvedValue({
          id: "shift-1",
          organizationId: "org-a",
          therapistId: "therapist-a",
          startsAt: new Date("2026-10-04T02:00:00.000Z"),
          endsAt: new Date("2026-10-04T10:00:00.000Z"),
          status: ShiftStatus.ACTIVE,
        }),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      staffMembership: {
        findFirst: vi.fn().mockResolvedValue({ id: "membership-1" }),
      },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    const scheduling = new SchedulingService(
      prisma as never,
      new AccessControlService(),
    );

    await expect(
      scheduling.createShift(dispatcher, {
        organizationId: "org-a",
        therapistId: "therapist-a",
        startsAt: "2026-10-04T10:00:00+08:00",
        endsAt: "2026-10-04T18:00:00+08:00",
      }),
    ).resolves.toMatchObject({ status: "ACTIVE" });
  });
});
