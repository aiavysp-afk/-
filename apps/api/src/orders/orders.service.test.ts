import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import {
  OrderStatus,
  ReservationStatus,
  TechnicianReviewStatus,
} from "@prisma/client";
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
    latitude: 34.75,
    longitude: 113.65,
    coordinateSystem: "GCJ-02",
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
      customerCoupon: { findMany: vi.fn().mockResolvedValue([]) },
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
      couponId: null,
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

  it("quotes claimed project-fee coupons and permits the customer to decline them", async () => {
    const prisma = {
      customerCoupon: { findMany: vi.fn().mockResolvedValue([{ id: "coupon-10", amountFen: 1000n }]) },
      appointmentReservation: {
        findUnique: vi.fn().mockResolvedValue({
          id: "reservation-1", organizationId: "org-a", customerId: principal.userId,
          status: ReservationStatus.HOLD, expiresAt: new Date("2026-10-03T00:10:00Z"),
          serviceAmountFen: 19800n,
        }),
      },
    };
    const service = new OrdersService(prisma as never, {} as never,
      new OrderStateMachine(), locations as never);
    await expect(service.quote(principal, "reservation-1")).resolves.toMatchObject({
      couponId: "coupon-10", serviceAmountFen: 19800, travelFeeFen: 0,
      discountFen: 1000, payableFen: 18800,
    });
    await expect(service.quote(principal, "reservation-1", null)).resolves.toMatchObject({
      couponId: null, discountFen: 0, payableFen: 19800,
    });
  });

  it("persists the discounted payable amount and consumes the quoted coupon in the order transaction", async () => {
    const tx = {
      customerCoupon: {
        findMany: vi.fn().mockResolvedValue([{ id: "coupon-10", amountFen: 1000n }]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      appointmentReservation: {
        findUnique: vi.fn().mockResolvedValue({
          id: "reservation-1", organizationId: "org-a", customerId: principal.userId,
          therapistId: "therapist-1", serviceId: "svc-neck-60", status: ReservationStatus.HOLD,
          startsAt: new Date("2026-10-04T02:00:00Z"), endsAt: new Date("2026-10-04T03:00:00Z"),
          expiresAt: new Date("2026-10-03T00:10:00Z"), serviceAmountFen: 19800n,
          service: { name: "肩颈舒缓", durationMinutes: 60 }, order: null,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      order: { create: vi.fn(async ({ data }) => orderRecord(data)) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      outboxEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    // Real nested Prisma creation returns item rows; mimic that without changing snapshots.
    tx.order.create.mockImplementation(async ({ data }) => orderRecord({
      ...data, items: orderRecord().items,
    }));
    const prisma = {
      order: { findUnique: vi.fn().mockResolvedValue(null) },
      user: { findUnique: vi.fn().mockResolvedValue({
        status: "ACTIVE", phoneEncrypted: "encrypted", phoneVerifiedAt: new Date(),
      }) },
      $transaction: vi.fn(async (callback: (db: typeof tx) => unknown) => callback(tx)),
    };
    const service = new OrdersService(prisma as never,
      { encrypt: vi.fn().mockReturnValue("encrypted") } as never,
      new OrderStateMachine(), locations as never);
    const result = await service.create(principal, { ...input, couponId: "coupon-10" }, "order-with-coupon");
    expect(result.data).toMatchObject({ serviceAmountFen: 19800, discountFen: 1000, payableFen: 18800 });
    expect(tx.order.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ discountFen: 1000n, payableFen: 18800n }),
    }));
    expect(tx.customerCoupon.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ usedOrderId: "order-1", status: "USED" }),
    }));
  });

  it("creates an order, snapshots the service, and writes audit plus outbox", async () => {
    const created = orderRecord();
    const tx = {
      customerCoupon: { findMany: vi.fn().mockResolvedValue([]) },
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
      user: {
        findUnique: vi.fn().mockResolvedValue({
          phoneEncrypted: "encrypted-phone",
          phoneVerifiedAt: new Date("2026-10-03T00:00:00.000Z"),
          status: "ACTIVE",
        }),
      },
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

  it("rejects a new order until the customer verifies a WeChat phone number", async () => {
    const prisma = {
      order: { findUnique: vi.fn().mockResolvedValue(null) },
      user: {
        findUnique: vi.fn().mockResolvedValue({
          phoneEncrypted: null,
          phoneVerifiedAt: null,
          status: "ACTIVE",
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
      service.create(principal, input, "order-unverified-customer"),
    ).rejects.toBeInstanceOf(ForbiddenException);
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
      customerCoupon: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
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
    expect(tx.customerCoupon.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ usedOrderId: "order-1", status: "USED" }),
      data: expect.objectContaining({ status: "AVAILABLE", usedOrderId: null }),
    }));
  });

  it("omits customer-hidden orders from the customer list", async () => {
    const prisma = {
      order: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const service = new OrdersService(
      prisma as never,
      {} as never,
      new OrderStateMachine(),
      locations as never,
    );
    await expect(service.listOwn(principal)).resolves.toEqual([]);
    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { customerId: principal.userId, customerHiddenAt: null },
        include: {
          items: true,
          technicianReview: { select: { status: true } },
        },
      }),
    );
  });

  it("returns the existing review status with an owned order", async () => {
    const prisma = {
      order: {
        findUnique: vi.fn().mockResolvedValue(
          orderRecord({
            technicianReview: {
              status: TechnicianReviewStatus.PENDING_REVIEW,
            },
          }),
        ),
      },
    };
    const service = new OrdersService(
      prisma as never,
      {} as never,
      new OrderStateMachine(),
      locations as never,
    );

    await expect(service.getOwn(principal, "order-1")).resolves.toMatchObject({
      id: "order-1",
      reviewStatus: TechnicianReviewStatus.PENDING_REVIEW,
    });
    expect(prisma.order.findUnique).toHaveBeenCalledWith({
      where: { id: "order-1" },
      include: {
        items: true,
        technicianReview: { select: { status: true } },
      },
    });
  });

  it.each([OrderStatus.CANCELLED, OrderStatus.REFUNDED])(
    "soft-hides a %s order while preserving its server record",
    async (status) => {
      const cancelled = orderRecord({
        status,
        customerHiddenAt: null,
      });
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        order: {
          findUnique: vi.fn().mockResolvedValue(cancelled),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        orderEvent: { create: vi.fn().mockResolvedValue({}) },
        auditLog: { create: vi.fn().mockResolvedValue({}) },
      };
      const prisma = {
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
      const now = new Date("2026-10-03T01:00:00.000Z");

      await expect(
        service.hideOwn(principal, cancelled.id, now),
      ).resolves.toEqual({
        orderId: cancelled.id,
        hiddenAt: now.toISOString(),
      });
      expect(tx.order.updateMany).toHaveBeenCalledWith({
        where: {
          id: cancelled.id,
          customerId: principal.userId,
          customerHiddenAt: null,
          status: { in: [OrderStatus.CANCELLED, OrderStatus.REFUNDED] },
        },
        data: { customerHiddenAt: now },
      });
      expect(tx.orderEvent.create).toHaveBeenCalledOnce();
      expect(tx.auditLog.create).toHaveBeenCalledOnce();
    },
  );

  it("refuses to hide another customer's order without changing any record", async () => {
    const order = orderRecord({
      customerId: "customer-2",
      status: OrderStatus.CANCELLED,
      customerHiddenAt: null,
    });
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      order: {
        findUnique: vi.fn().mockResolvedValue(order),
        updateMany: vi.fn(),
        delete: vi.fn(),
      },
      orderEvent: { create: vi.fn() },
      auditLog: { create: vi.fn() },
    };
    const prisma = {
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

    await expect(service.hideOwn(principal, order.id)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(tx.order.updateMany).not.toHaveBeenCalled();
    expect(tx.order.delete).not.toHaveBeenCalled();
    expect(tx.orderEvent.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("replays a hidden order's original timestamp without duplicate events or audits", async () => {
    const now = new Date("2026-10-03T01:00:00.000Z");
    const cancelled = orderRecord({
      status: OrderStatus.CANCELLED,
      customerHiddenAt: null,
    });
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      order: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce(cancelled)
          .mockResolvedValue({ ...cancelled, customerHiddenAt: now }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        delete: vi.fn(),
      },
      orderEvent: { create: vi.fn().mockResolvedValue({}) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
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
    const expected = { orderId: cancelled.id, hiddenAt: now.toISOString() };

    await expect(
      service.hideOwn(principal, cancelled.id, now),
    ).resolves.toEqual(expected);
    await expect(
      service.hideOwn(
        principal,
        cancelled.id,
        new Date("2026-10-03T02:00:00.000Z"),
      ),
    ).resolves.toEqual(expected);
    expect(tx.order.updateMany).toHaveBeenCalledOnce();
    expect(tx.order.delete).not.toHaveBeenCalled();
    expect(tx.orderEvent.create).toHaveBeenCalledOnce();
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
  });

  it.each([
    OrderStatus.ASSIGNED,
    OrderStatus.IN_SERVICE,
    OrderStatus.REFUNDING,
  ])(
    "refuses to hide a %s order or reveal an already hidden order",
    async (status) => {
      const active = orderRecord({
        status,
        customerHiddenAt: null,
      });
      const hidden = orderRecord({
        status: OrderStatus.CANCELLED,
        customerHiddenAt: new Date("2026-10-03T01:00:00.000Z"),
      });
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        order: {
          findUnique: vi.fn().mockResolvedValueOnce(active),
          updateMany: vi.fn(),
        },
        orderEvent: { create: vi.fn() },
        auditLog: { create: vi.fn() },
      };
      const prisma = {
        order: { findUnique: vi.fn().mockResolvedValue(hidden) },
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
        service.hideOwn(principal, active.id),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(service.getOwn(principal, hidden.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(tx.order.updateMany).not.toHaveBeenCalled();
      expect(tx.orderEvent.create).not.toHaveBeenCalled();
      expect(tx.auditLog.create).not.toHaveBeenCalled();
    },
  );
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

  it("confirms service completion atomically and writes one event, audit and outbox record", async () => {
    const awaiting = orderRecord({
      status: OrderStatus.AWAITING_CONFIRMATION,
    });
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      order: {
        findUnique: vi.fn().mockResolvedValue(awaiting),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      orderEvent: { create: vi.fn().mockResolvedValue({}) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      outboxEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
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
      service.confirmCompletion(principal, awaiting.id),
    ).resolves.toEqual({
      orderId: awaiting.id,
      previousStatus: OrderStatus.AWAITING_CONFIRMATION,
      status: OrderStatus.COMPLETED,
      idempotentReplay: false,
    });
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: {
        id: awaiting.id,
        customerId: principal.userId,
        status: OrderStatus.AWAITING_CONFIRMATION,
      },
      data: { status: OrderStatus.COMPLETED },
    });
    expect(tx.orderEvent.create).toHaveBeenCalledOnce();
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
    expect(tx.outboxEvent.create).toHaveBeenCalledOnce();
  });

  it("treats a repeated customer completion confirmation as idempotent", async () => {
    const completed = orderRecord({ status: OrderStatus.COMPLETED });
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      order: {
        findUnique: vi.fn().mockResolvedValue(completed),
        updateMany: vi.fn(),
      },
      orderEvent: { create: vi.fn() },
      auditLog: { create: vi.fn() },
      outboxEvent: { create: vi.fn() },
    };
    const prisma = {
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
      service.confirmCompletion(principal, completed.id),
    ).resolves.toMatchObject({
      status: OrderStatus.COMPLETED,
      idempotentReplay: true,
    });
    expect(tx.order.updateMany).not.toHaveBeenCalled();
    expect(tx.orderEvent.create).not.toHaveBeenCalled();
  });

  it("rejects completion confirmation from a different customer", async () => {
    const awaiting = orderRecord({
      customerId: "another-customer",
      status: OrderStatus.AWAITING_CONFIRMATION,
    });
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      order: {
        findUnique: vi.fn().mockResolvedValue(awaiting),
        updateMany: vi.fn(),
      },
    };
    const prisma = {
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
      service.confirmCompletion(principal, awaiting.id),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.order.updateMany).not.toHaveBeenCalled();
  });

  it("rejects customer confirmation before the technician submits completion", async () => {
    const assigned = orderRecord({ status: OrderStatus.ASSIGNED });
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      order: {
        findUnique: vi.fn().mockResolvedValue(assigned),
        updateMany: vi.fn(),
      },
    };
    const prisma = {
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
      service.confirmCompletion(principal, assigned.id),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.order.updateMany).not.toHaveBeenCalled();
  });
});
