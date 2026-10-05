import { ConflictException, ForbiddenException } from "@nestjs/common";
import { OrderStatus, ReservationStatus } from "@prisma/client";
import type { OrderCreate } from "@zydj/contracts";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { OrderStateMachine } from "./order-state-machine.js";
import { OrdersService } from "./orders.service.js";

const principal: AuthPrincipal = {
  sessionId: "session-customer",
  userId: "customer-1",
  displayName: "客户",
  memberships: [],
};
const locations = {
  assertOrderVerification: vi.fn().mockResolvedValue(undefined),
};

const input: OrderCreate = {
  reservationId: "reservation-1",
  address: {
    contactName: "林女士",
    phone: "13800000000",
    detail: "郑州市金水区示例路 1 号",
  },
};

const orderRecord = (overrides: Record<string, unknown> = {}) => ({
  id: "order-1",
  orderNo: "ZY20261003ABCDEF01",
  organizationId: "org-a",
  customerId: principal.userId,
  therapistId: "therapist-1",
  reservationId: "reservation-1",
  status: OrderStatus.PENDING_PAYMENT,
  appointmentStart: new Date("2026-10-04T02:00:00.000Z"),
  appointmentEnd: new Date("2026-10-04T03:00:00.000Z"),
  serviceAmountFen: 19_800n,
  travelFeeFen: 0n,
  discountFen: 0n,
  payableFen: 19_800n,
  addressEncrypted: "encrypted",
  policyVersion: "test",
  paymentExpiresAt: new Date("2026-10-03T00:15:00.000Z"),
  createdAt: new Date("2026-10-03T00:00:00.000Z"),
  updatedAt: new Date("2026-10-03T00:00:00.000Z"),
  idempotencyKey: "order-20261003-0001",
  requestFingerprint: createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex"),
  items: [
    {
      id: "item-1",
      serviceName: "肩颈舒缓",
      serviceId: "svc-neck-60",
      durationMinutes: 60,
      unitPriceFen: 19_800n,
      quantity: 1,
      orderId: "order-1",
    },
  ],
  ...overrides,
});

describe("OrdersService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T00:00:00.000Z"));
    locations.assertOrderVerification.mockClear();
  });

  afterEach(() => vi.useRealTimers());

  it("quotes the frozen reservation amount in integer fen", async () => {
    const prisma = {
      appointmentReservation: {
        findUnique: vi.fn().mockResolvedValue({
          id: "reservation-1",
          customerId: principal.userId,
          status: ReservationStatus.HOLD,
          expiresAt: new Date("2026-10-03T00:10:00.000Z"),
          serviceAmountFen: 19_800n,
        }),
      },
    };
    const service = new OrdersService(
      prisma as never,
      {} as never,
      new OrderStateMachine(),
      locations as never,
    );

    await expect(service.quote(principal, "reservation-1")).resolves.toEqual({
      reservationId: "reservation-1",
      serviceAmountFen: 19_800,
      travelFeeFen: 0,
      discountFen: 0,
      payableFen: 19_800,
      currency: "CNY",
      moneyUnit: "fen",
    });
  });

  it("rejects quoting another customer's reservation", async () => {
    const prisma = {
      appointmentReservation: {
        findUnique: vi.fn().mockResolvedValue({
          id: "reservation-1",
          customerId: "another-customer",
          status: ReservationStatus.HOLD,
          expiresAt: new Date("2026-10-03T00:10:00.000Z"),
          serviceAmountFen: 19_800n,
        }),
      },
    };
    const service = new OrdersService(
      prisma as never,
      {} as never,
      new OrderStateMachine(),
      locations as never,
    );
    await expect(
      service.quote(principal, "reservation-1"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("creates an order, snapshots the service, and writes audit plus outbox", async () => {
    const created = orderRecord();
    const tx = {
      appointmentReservation: {
        findUnique: vi.fn().mockResolvedValue({
          id: "reservation-1",
          organizationId: "org-a",
          customerId: principal.userId,
          therapistId: "therapist-1",
          serviceId: "svc-neck-60",
          status: ReservationStatus.HOLD,
          startsAt: new Date("2026-10-04T02:00:00.000Z"),
          endsAt: new Date("2026-10-04T03:00:00.000Z"),
          expiresAt: new Date("2026-10-03T00:10:00.000Z"),
          serviceAmountFen: 19_800n,
          service: { name: "肩颈舒缓", durationMinutes: 60 },
          order: null,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      order: { create: vi.fn().mockResolvedValue(created) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      outboxEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      order: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    const crypto = { encrypt: vi.fn().mockReturnValue("encrypted-address") };
    const service = new OrdersService(
      prisma as never,
      crypto as never,
      new OrderStateMachine(),
      locations as never,
    );

    const result = await service.create(
      principal,
      input,
      "order-20261003-0001",
    );

    expect(result.idempotentReplay).toBe(false);
    expect(result.data).toMatchObject({
      id: "order-1",
      status: "PENDING_PAYMENT",
      payableFen: 19_800,
    });
    expect(tx.order.create).toHaveBeenCalledOnce();
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
    expect(tx.outboxEvent.create).toHaveBeenCalledOnce();
    expect(crypto.encrypt).toHaveBeenCalledOnce();
    expect(locations.assertOrderVerification).toHaveBeenCalledOnce();
  });

  it("returns the same order for an identical idempotent replay", async () => {
    const existing = orderRecord();
    const prisma = {
      order: { findUnique: vi.fn().mockResolvedValue(existing) },
    };
    const service = new OrdersService(
      prisma as never,
      {} as never,
      new OrderStateMachine(),
      locations as never,
    );
    await expect(
      service.create(principal, input, "order-20261003-0001"),
    ).resolves.toMatchObject({
      idempotentReplay: true,
      data: { id: "order-1" },
    });
  });

  it("rejects reuse of an idempotency key for a different request", async () => {
    const existing = orderRecord();
    const prisma = {
      order: { findUnique: vi.fn().mockResolvedValue(existing) },
    };
    const service = new OrdersService(
      prisma as never,
      {} as never,
      new OrderStateMachine(),
      locations as never,
    );
    await expect(
      service.create(
        principal,
        {
          ...input,
          address: { ...input.address, detail: "不同服务地址 2 号" },
        },
        "order-20261003-0001",
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("cancels a pending order and releases its reservation atomically", async () => {
    const current = orderRecord();
    const cancelled = orderRecord({ status: OrderStatus.CANCELLED });
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      order: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi
          .fn()
          .mockResolvedValueOnce(current)
          .mockResolvedValue(cancelled),
      },
      appointmentReservation: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      orderEvent: { create: vi.fn().mockResolvedValue({}) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      outboxEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      order: { findUnique: vi.fn().mockResolvedValue(current) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    const service = new OrdersService(
      prisma as never,
      {} as never,
      new OrderStateMachine(),
      locations as never,
    );

    await expect(
      service.cancelOwn(principal, "order-1"),
    ).resolves.toMatchObject({
      status: "CANCELLED",
    });
    expect(tx.appointmentReservation.updateMany).toHaveBeenCalledWith({
      where: { id: "reservation-1", status: ReservationStatus.HOLD },
      data: { status: ReservationStatus.RELEASED },
    });
  });
  it("does not release a reservation when a WeChat intent appeared while cancellation waited for the order lock", async () => {
    const current = orderRecord();
    const tx = {
      $queryRaw: vi.fn(async () => []),
      order: {
        findUniqueOrThrow: vi.fn(async () => ({
          ...current,
          payment: { provider: "WECHAT", status: "PENDING" },
        })),
        updateMany: vi.fn(),
      },
      appointmentReservation: { updateMany: vi.fn() },
    };
    const prisma = {
      order: { findUnique: vi.fn(async () => current) },
      $transaction: vi.fn(async (cb: any) => cb(tx)),
    };
    const service = new OrdersService(
      prisma as never,
      {} as never,
      new OrderStateMachine(),
      locations as never,
    );
    await expect(service.cancelOwn(principal, current.id)).rejects.toThrow(
      "原单尚未确认关闭",
    );
    expect(tx.order.updateMany).not.toHaveBeenCalled();
    expect(tx.appointmentReservation.updateMany).not.toHaveBeenCalled();
  });
});
