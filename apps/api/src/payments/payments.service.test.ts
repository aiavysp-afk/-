import { ConflictException, NotFoundException } from "@nestjs/common";
import {
  OrderStatus,
  PaymentProvider,
  PaymentStatus,
  ReservationStatus,
} from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { OrderStateMachine } from "../orders/order-state-machine.js";
import { PaymentsService } from "./payments.service.js";

const principal: AuthPrincipal = {
  sessionId: "session-1",
  userId: "customer-1",
  displayName: "客户",
  memberships: [],
};

const expiresAt = new Date("2026-10-03T00:15:00.000Z");

const paymentRecord = (overrides: Record<string, unknown> = {}) => ({
  id: "payment-1",
  orderId: "order-1",
  provider: PaymentProvider.MOCK,
  status: PaymentStatus.PENDING,
  merchantPaymentNo: "PAY-1",
  amountFen: 19_800n,
  providerReference: "mock-prepay-PAY-1",
  providerTransactionId: null,
  failureCode: null,
  createdAt: new Date("2026-10-03T00:00:00.000Z"),
  updatedAt: new Date("2026-10-03T00:00:00.000Z"),
  succeededAt: null,
  closedAt: null,
  ...overrides,
});

const orderRecord = (overrides: Record<string, unknown> = {}) => ({
  id: "order-1",
  organizationId: "org-a",
  customerId: principal.userId,
  reservationId: "reservation-1",
  status: OrderStatus.PENDING_PAYMENT,
  payableFen: 19_800n,
  paymentExpiresAt: expiresAt,
  payment: null,
  ...overrides,
});

const config = (nodeEnv = "development") =>
  ({ get: (key: string) => (key === "NODE_ENV" ? nodeEnv : "mock") }) as never;

describe("PaymentsService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T00:00:00.000Z"));
  });

  afterEach(() => vi.useRealTimers());

  it("creates one mock payment intent with audit and payment event", async () => {
    const payment = paymentRecord();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      order: { findUniqueOrThrow: vi.fn().mockResolvedValue(orderRecord()) },
      payment: { create: vi.fn().mockResolvedValue(payment) },
      paymentEvent: { create: vi.fn().mockResolvedValue({}) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      order: { findUnique: vi.fn().mockResolvedValue(orderRecord()) },
      payment: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    const gateway = {
      prepare: vi.fn().mockReturnValue({
        provider: PaymentProvider.MOCK,
        providerReference: "mock-prepay-PAY-1",
      }),
    };
    const service = new PaymentsService(
      prisma as never,
      config(),
      new OrderStateMachine(),
      gateway as never,
    );

    await expect(
      service.createIntent(principal, "order-1"),
    ).resolves.toMatchObject({
      id: "payment-1",
      provider: "MOCK",
      status: "PENDING",
      amountFen: 19_800,
      mockConfirmationAvailable: true,
    });
    expect(tx.paymentEvent.create).toHaveBeenCalledOnce();
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
  });

  it("returns the existing payment intent instead of creating a duplicate", async () => {
    const payment = paymentRecord();
    const prisma = {
      order: {
        findUnique: vi.fn().mockResolvedValue(orderRecord({ payment })),
      },
    };
    const gateway = { configuredProvider: vi.fn() };
    const service = new PaymentsService(
      prisma as never,
      config(),
      new OrderStateMachine(),
      gateway as never,
    );
    await expect(
      service.createIntent(principal, "order-1"),
    ).resolves.toMatchObject({
      id: "payment-1",
    });
  });

  it("rejects a payment intent if the order was cancelled while waiting for its row lock", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      order: {
        findUniqueOrThrow: vi
          .fn()
          .mockResolvedValue(orderRecord({ status: OrderStatus.CANCELLED })),
      },
      payment: { create: vi.fn() },
    };
    const prisma = {
      order: { findUnique: vi.fn().mockResolvedValue(orderRecord()) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    const gateway = {
      prepare: () => ({
        provider: PaymentProvider.MOCK,
        providerReference: "mock-test",
      }),
    };
    const service = new PaymentsService(
      prisma as never,
      config(),
      new OrderStateMachine(),
      gateway as never,
    );
    await expect(
      service.createIntent(principal, "order-1"),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.payment.create).not.toHaveBeenCalled();
  });

  it("confirms a mock payment and atomically confirms the reservation", async () => {
    const pending = paymentRecord({
      order: orderRecord({
        reservation: {
          id: "reservation-1",
          status: ReservationStatus.HOLD,
        },
      }),
    });
    const succeeded = paymentRecord({
      status: PaymentStatus.SUCCEEDED,
      providerTransactionId: "mock-payment-1",
      succeededAt: new Date(),
    });
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      payment: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi
          .fn()
          .mockResolvedValueOnce(pending)
          .mockResolvedValueOnce(succeeded),
      },
      order: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      appointmentReservation: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      paymentEvent: { create: vi.fn().mockResolvedValue({}) },
      orderEvent: { create: vi.fn().mockResolvedValue({}) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      outboxEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      payment: { findUnique: vi.fn().mockResolvedValue(pending) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    const gateway = {
      configuredProvider: vi.fn().mockReturnValue(PaymentProvider.MOCK),
    };
    const service = new PaymentsService(
      prisma as never,
      config(),
      new OrderStateMachine(),
      gateway as never,
    );

    await expect(
      service.confirmMock(principal, "payment-1"),
    ).resolves.toMatchObject({
      status: "SUCCEEDED",
    });
    expect(tx.appointmentReservation.updateMany).toHaveBeenCalledWith({
      where: {
        id: "reservation-1",
        status: ReservationStatus.HOLD,
        expiresAt: { gt: new Date("2026-10-03T00:00:00.000Z") },
      },
      data: { status: ReservationStatus.CONFIRMED },
    });
    expect(tx.outboxEvent.create).toHaveBeenCalledOnce();
  });

  it("closes expired pending orders and releases their reservation lock", async () => {
    const order = orderRecord({
      paymentExpiresAt: new Date("2026-10-02T23:59:00.000Z"),
      payment: paymentRecord(),
    });
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      order: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(order),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      appointmentReservation: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      payment: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      paymentEvent: { create: vi.fn().mockResolvedValue({}) },
      orderEvent: { create: vi.fn().mockResolvedValue({}) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      outboxEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      order: { findMany: vi.fn().mockResolvedValue([order]) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    const service = new PaymentsService(
      prisma as never,
      config(),
      new OrderStateMachine(),
      {} as never,
    );

    await expect(service.expirePendingOrders()).resolves.toBe(1);
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: "order-1", status: OrderStatus.PENDING_PAYMENT },
      data: { status: OrderStatus.CANCELLED },
    });
    expect(tx.appointmentReservation.updateMany).toHaveBeenCalledWith({
      where: { id: "reservation-1", status: ReservationStatus.HOLD },
      data: { status: ReservationStatus.EXPIRED },
    });
  });

  it("does not expire a real prepay created after the initial mock scan", async () => {
    const stale = orderRecord({
      paymentExpiresAt: new Date(Date.now() - 1),
      payment: null,
    });
    const fresh = {
      ...stale,
      payment: paymentRecord({ provider: PaymentProvider.WECHAT }),
    };
    const tx = {
      $queryRaw: vi.fn(async () => []),
      order: {
        findUniqueOrThrow: vi.fn(async () => fresh),
        updateMany: vi.fn(),
      },
    };
    const prisma = {
      order: { findMany: vi.fn(async () => [stale]) },
      $transaction: vi.fn(async (cb: any) => cb(tx)),
    };
    const service = new PaymentsService(
      prisma as never,
      config(),
      new OrderStateMachine(),
      {} as never,
    );
    expect(await service.expirePendingOrders()).toBe(0);
    expect(tx.order.updateMany).not.toHaveBeenCalled();
  });
  it("hides the mock success endpoint in production", async () => {
    const service = new PaymentsService(
      {} as never,
      config("production"),
      new OrderStateMachine(),
      { configuredProvider: () => PaymentProvider.MOCK } as never,
    );
    await expect(
      service.confirmMock(principal, "payment-1"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("rejects payment confirmation when the amount differs from the order", async () => {
    const pending = paymentRecord({
      amountFen: 1n,
      order: orderRecord({ reservation: { id: "reservation-1" } }),
    });
    const prisma = {
      payment: { findUnique: vi.fn().mockResolvedValue(pending) },
    };
    const service = new PaymentsService(
      prisma as never,
      config(),
      new OrderStateMachine(),
      { configuredProvider: () => PaymentProvider.MOCK } as never,
    );
    await expect(
      service.confirmMock(principal, "payment-1"),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
