import { ConflictException, ForbiddenException } from "@nestjs/common";
import {
  OrderStatus,
  PaymentProvider,
  PaymentStatus,
  ReservationStatus,
} from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WechatPaymentsService } from "./wechat-payments.service.js";
import type { WechatTransaction } from "./wechat-pay.protocol.js";

const transaction: WechatTransaction = {
  appid: "app-1",
  mchid: "merchant-1",
  out_trade_no: "PAY123",
  transaction_id: "wx-txn-1",
  trade_type: "JSAPI",
  trade_state: "SUCCESS",
  success_time: "2026-10-03T00:00:00Z",
  amount: { total: 19800, currency: "CNY" },
};
const principal = {
  userId: "customer-1",
  sessionId: "session-1",
  displayName: "客户",
  memberships: [],
};

function setup(
  overrides: Record<string, unknown> = {},
  previous: unknown = null,
) {
  const order = {
    id: "order-1",
    customerId: "customer-1",
    organizationId: "org-1",
    payableFen: 19800n,
    status: OrderStatus.PENDING_PAYMENT,
    paymentExpiresAt: new Date("2026-10-03T00:15:00Z"),
    reservation: {
      id: "slot-1",
      status: ReservationStatus.HOLD,
      expiresAt: new Date("2026-10-03T00:15:00Z"),
    },
  };
  const payment = {
    id: "payment-1",
    orderId: order.id,
    provider: PaymentProvider.WECHAT,
    status: PaymentStatus.PENDING,
    amountFen: 19800n,
    merchantPaymentNo: "PAY123",
    providerTransactionId: null,
    order,
    ...overrides,
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    payment: {
      findUniqueOrThrow: vi.fn().mockResolvedValue(payment),
      update: vi.fn().mockResolvedValue({}),
    },
    order: { update: vi.fn().mockResolvedValue({}) },
    appointmentReservation: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    paymentEvent: {
      findUnique: vi.fn().mockResolvedValue(previous),
      create: vi.fn().mockResolvedValue({}),
    },
    orderEvent: { create: vi.fn().mockResolvedValue({}) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    outboxEvent: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    payment: {
      findUnique: vi.fn().mockResolvedValue(payment),
      findUniqueOrThrow: vi.fn().mockResolvedValue(payment),
    },
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  const client = {
    verifierConfig: () => ({ appId: "app-1", merchantId: "merchant-1" }),
    queryTransaction: vi.fn().mockResolvedValue(transaction),
  };
  const storedValueRecharges = {
    applyIfPresent: vi.fn().mockResolvedValue(false),
  };
  return {
    service: new WechatPaymentsService(
      prisma as never,
      client as never,
      storedValueRecharges as never,
    ),
    tx,
    client,
    prisma,
    order,
  };
}

describe("WechatPaymentsService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T00:01:00Z"));
  });
  afterEach(() => vi.useRealTimers());
  it("records successful payment and confirms fulfillment in a single transaction", async () => {
    const { service, tx } = setup();
    await expect(
      service.applyTransaction(transaction, "event-1", "NOTIFICATION"),
    ).resolves.toEqual({ duplicate: false });
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(tx.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SUCCEEDED",
          providerTransactionId: "wx-txn-1",
          failureCode: null,
        }),
      }),
    );
    expect(tx.order.update).toHaveBeenCalledWith({
      where: { id: "order-1" },
      data: { status: "PAID" },
    });
    expect(tx.appointmentReservation.updateMany).toHaveBeenCalledOnce();
    expect(tx.outboxEvent.create).toHaveBeenCalledOnce();
  });
  it("acknowledges duplicates even after fulfillment has progressed", async () => {
    const { service, tx, order } = setup({
      status: PaymentStatus.SUCCEEDED,
      providerTransactionId: "wx-txn-1",
    });
    order.status = OrderStatus.ASSIGNED as "PENDING_PAYMENT";
    await expect(
      service.applyTransaction(transaction, "event-1", "NOTIFICATION"),
    ).resolves.toEqual({ duplicate: true });
    expect(tx.payment.update).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });
  it("records late payment for review without restoring a cancelled reservation", async () => {
    const { service, tx, order } = setup({ status: PaymentStatus.CLOSED });
    order.status = OrderStatus.CANCELLED as "PENDING_PAYMENT";
    order.reservation.status = ReservationStatus.EXPIRED as "HOLD";
    await service.applyTransaction(transaction, "event-late", "NOTIFICATION");
    expect(tx.order.update).not.toHaveBeenCalled();
    expect(tx.appointmentReservation.updateMany).not.toHaveBeenCalled();
    expect(tx.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SUCCEEDED",
          failureCode: "FULFILLMENT_REVIEW_REQUIRED",
        }),
      }),
    );
    expect(tx.outboxEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "PAYMENT_FULFILLMENT_REVIEW_REQUIRED",
        }),
      }),
    );
  });
  it("does not confirm an expired hold even when the provider payment was timely", async () => {
    const { service, tx } = setup();
    vi.setSystemTime(new Date("2026-10-03T00:20:00Z"));
    await service.applyTransaction(transaction, "event-late", "NOTIFICATION");
    expect(tx.order.update).toHaveBeenCalledWith({
      where: { id: "order-1" },
      data: { status: "CANCELLED" },
    });
    expect(tx.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          failureCode: "FULFILLMENT_REVIEW_REQUIRED",
        }),
      }),
    );
  });
  it.each([
    { amount: { total: 1, currency: "CNY" as const } },
    { transaction_id: "other-txn" },
  ])("rejects amount/transaction mismatch without writes", async (changes) => {
    const { service, tx } = setup({
      status: PaymentStatus.SUCCEEDED,
      providerTransactionId: "wx-txn-1",
    });
    await expect(
      service.applyTransaction(
        { ...transaction, ...changes },
        "event-1",
        "NOTIFICATION",
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.payment.update).not.toHaveBeenCalled();
  });
  it("rejects notification ID already bound to a different payment", async () => {
    const { service, tx } = setup({}, { paymentId: "other-payment" });
    await expect(
      service.applyTransaction(transaction, "event-1", "NOTIFICATION"),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.payment.update).not.toHaveBeenCalled();
  });
  it("checks ownership before contacting the provider", async () => {
    const { service, client } = setup();
    await expect(
      service.reconcile({ ...principal, userId: "other-user" }, "payment-1"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(client.queryTransaction).not.toHaveBeenCalled();
  });
  it("uses verified query success for the same atomic transition", async () => {
    const { service, tx } = setup();
    await service.reconcile(principal, "payment-1");
    expect(tx.paymentEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ providerEventId: "QUERY:wx-txn-1" }),
      }),
    );
  });
  it("does not close local orders merely from a non-success query", async () => {
    const { service, tx, client } = setup();
    client.queryTransaction.mockResolvedValue({
      ...transaction,
      trade_state: "NOTPAY",
    });
    await expect(
      service.reconcile(principal, "payment-1"),
    ).resolves.toMatchObject({ status: "PENDING", providerState: "NOTPAY" });
    expect(tx.payment.update).not.toHaveBeenCalled();
    expect(tx.order.update).not.toHaveBeenCalled();
  });
});
