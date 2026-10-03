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
