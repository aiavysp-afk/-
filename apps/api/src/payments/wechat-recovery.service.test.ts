import {
  ForbiddenException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WechatRecoveryService } from "./wechat-recovery.service.js";

function fixture(expired = true) {
  const order: any = {
    id: "order",
    customerId: "customer",
    organizationId: "org",
    status: "PENDING_PAYMENT",
    payableFen: 19800n,
    reservationId: "hold",
    paymentExpiresAt: new Date(Date.now() + (expired ? -60_000 : 900_000)),
    reservation: {
      id: "hold",
      status: "HOLD",
      expiresAt: new Date(Date.now() + (expired ? -60_000 : 900_000)),
    },
  };
  const payment: any = {
    id: "payment",
    orderId: "order",
    provider: "WECHAT",
    status: "PENDING",
    merchantPaymentNo: "PAY123456",
    amountFen: 19800n,
    providerTransactionId: null,
    closeState: "NONE",
    closeRequestedAt: null,
    closeReason: null,
    closeAttempts: 0,
    recoveryAttempts: 0,
    recoveryReviewAt: null,
    recoveryNextCheckAt: null,
    recoveryLeaseToken: null,
    recoveryLeaseUntil: null,
    order,
  };
  order.payment = payment;
  const update = vi.fn(async ({ data }: any) => {
    for (const [key, value] of Object.entries(data))
      payment[key] =
        value && typeof value === "object" && "increment" in value
          ? payment[key] + (value as any).increment
          : value;
    return { ...payment };
  });
  const tx = {
    customerCoupon: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    $queryRaw: vi.fn(async () => []),
    payment: { findUniqueOrThrow: vi.fn(async () => ({ ...payment })), update },
    order: {
      findUniqueOrThrow: vi.fn(async () => ({ ...order })),
      update: vi.fn(async ({ data }: any) => Object.assign(order, data)),
    },
    appointmentReservation: {
      updateMany: vi.fn(async ({ data }: any) => {
        Object.assign(order.reservation, data);
        return { count: 1 };
      }),
    },
    paymentEvent: { create: vi.fn(async () => ({})) },
    orderEvent: { create: vi.fn(async () => ({})) },
    auditLog: { create: vi.fn(async () => ({})) },
    outboxEvent: { create: vi.fn(async () => ({})) },
  };
  let queue = Promise.resolve();
  const prisma = {
    order: { findUnique: vi.fn(async () => ({ ...order })) },
    payment: {
      findUnique: vi.fn(async () => ({ ...payment })),
      findUniqueOrThrow: vi.fn(async () => ({ ...payment })),
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (
          where.status !== payment.status ||
          where.recoveryLeaseToken !== payment.recoveryLeaseToken ||
          (where.recoveryLeaseUntil &&
            payment.recoveryLeaseUntil <= where.recoveryLeaseUntil.gt)
        )
          return { count: 0 };
        await update({ data });
        return { count: 1 };
      }),
    },
    $transaction: vi.fn((cb: any) => {
      const result = queue.then(() => cb(tx));
      queue = result.then(
        () => {},
        () => {},
      );
      return result;
    }),
  };
  const identity = { appId: "app", merchantId: "1234567890" };
  const result = (state: string, amount = true) => ({
    appid: identity.appId,
    mchid: identity.merchantId,
    out_trade_no: payment.merchantPaymentNo,
    trade_state: state,
    ...(amount ? { amount: { total: 19800, currency: "CNY" } } : {}),
    ...(state === "SUCCESS"
      ? {
          trade_type: "JSAPI",
          transaction_id: "wx-txn",
          success_time: new Date().toISOString(),
        }
      : {}),
  });
  const client = {
    assertRecoveryEnabled: vi.fn(),
    verifierConfig: () => identity,
    queryTransaction: vi.fn(async () => result("NOTPAY")),
    closeTransaction: vi.fn(async () => {}),
  };
  const payments = {
    applyTransaction: vi.fn(async () => {
      payment.status = "SUCCEEDED";
      payment.providerTransactionId = "wx-txn";
      payment.recoveryLeaseToken = null;
      payment.recoveryLeaseUntil = null;
      order.status = expired ? "CANCELLED" : "PAID";
      order.reservation.status = expired ? "EXPIRED" : "CONFIRMED";
    }),
  };
  const orders = {
    getOwn: vi.fn(async () => ({ id: order.id, status: order.status })),
    cancelOwn: vi.fn(async () => ({ status: "CANCELLED" })),
  };
  const env: any = {
    PAYMENT_PROVIDER: "wechat",
    WECHAT_PAY_RECOVERY_ENABLED: "true",
  };
  const service = new WechatRecoveryService(
    prisma as never,
    { get: (k: string) => env[k] } as never,
    client as never,
    payments as never,
    orders as never,
  );
  const principal = {
    userId: "customer",
    displayName: "客户",
    sessionId: "session",
    memberships: [],
  };
  return {
    service,
    prisma,
    tx,
    client,
    payments,
    orders,
    order,
    payment,
    env,
    result,
    principal,
  };
}

describe("original-order query/close/recheck recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-04T02:00:00+08:00"));
  });
  afterEach(() => vi.useRealTimers());
  it("defaults to no I/O or writes when the recovery gate is closed", async () => {
    const f = fixture();
    f.env.WECHAT_PAY_RECOVERY_ENABLED = "false";
    expect(await f.service.recover("payment")).toBe(false);
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
    expect(f.client.queryTransaction).not.toHaveBeenCalled();
  });
  it("never releases a hold on a close acknowledgement alone", async () => {
    const f = fixture();
    await f.service.recover("payment");
    expect(f.client.closeTransaction).toHaveBeenCalledExactlyOnceWith(
      "PAY123456",
    );
    expect(f.client.queryTransaction).toHaveBeenCalledTimes(2);
    expect(f.payment.closeState).toBe("UNKNOWN");
    expect(f.order.reservation.status).toBe("HOLD");
    expect(f.payment.status).toBe("PENDING");
    expect(f.payment.recoveryNextCheckAt).toBeInstanceOf(Date);
  });
  it("commits the dispatch before I/O and closes only after verified CLOSED", async () => {
    const f = fixture();
    f.client.queryTransaction
      .mockResolvedValueOnce(f.result("NOTPAY"))
      .mockResolvedValueOnce(f.result("CLOSED", false));
    f.client.closeTransaction.mockImplementation(async () => {
      expect(f.payment.closeState).toBe("DISPATCHING");
      expect(f.payment.closeAttempts).toBe(1);
    });
    await f.service.recover("payment");
    expect(f.payment.status).toBe("CLOSED");
    expect(f.payment.closeState).toBe("CONFIRMED");
    expect(f.order.status).toBe("CANCELLED");
    expect(f.order.reservation.status).toBe("EXPIRED");
    expect(f.tx.customerCoupon.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ usedOrderId: "order", status: "USED" }),
      data: expect.objectContaining({ status: "AVAILABLE", usedOrderId: null }),
    }));
    expect(f.payment.recoveryLeaseToken).toBeNull();
    expect(f.tx.outboxEvent.create).toHaveBeenCalledOnce();
    await f.service.recover("payment");
    expect(f.client.closeTransaction).toHaveBeenCalledOnce();
  });
  it("verified provider CLOSED without a close POST is also terminal evidence", async () => {
    const f = fixture(false);
    f.client.queryTransaction.mockResolvedValue(f.result("CLOSED", false));
    await f.service.recover("payment");
    expect(f.client.closeTransaction).not.toHaveBeenCalled();
    expect(f.payment.closeReason).toBe("PROVIDER_CLOSED");
    expect(f.order.reservation.status).toBe("RELEASED");
  });
  it.each(["USERPAYING", "PAYERROR", "REFUND", "REVOKED", "ACCEPTED"])(
    "keeps %s for retry/review without closing",
    async (state) => {
      const f = fixture();
      f.client.queryTransaction.mockResolvedValue(f.result(state, false));
      await f.service.recover("payment");
      expect(f.client.closeTransaction).not.toHaveBeenCalled();
      expect(f.order.reservation.status).toBe("HOLD");
    },
  );
  it("does not close a valid unexpired NOTPAY order without a cancellation intent", async () => {
    const f = fixture(false);
    await f.service.recover("payment");
    expect(f.client.closeTransaction).not.toHaveBeenCalled();
    expect(f.payment.closeRequestedAt).toBeNull();
  });
  it("routes verified success to settlement and never sends close", async () => {
    const f = fixture(false);
    f.client.queryTransaction.mockResolvedValue(f.result("SUCCESS"));
    await f.service.recover("payment");
    expect(f.payments.applyTransaction).toHaveBeenCalledOnce();
    expect(f.client.closeTransaction).not.toHaveBeenCalled();
    expect(f.payment.status).toBe("SUCCEEDED");
  });
  it("payment wins the close race and is recorded rather than cancelled", async () => {
    const f = fixture(false);
    f.payment.closeRequestedAt = new Date();
    f.payment.closeReason = "CUSTOMER";
    f.client.queryTransaction
      .mockResolvedValueOnce(f.result("NOTPAY"))
      .mockResolvedValueOnce(f.result("SUCCESS"));
    f.client.closeTransaction.mockRejectedValue(
      new Error("paid while closing"),
    );
    await f.service.recover("payment");
    expect(f.payment.status).toBe("SUCCEEDED");
    expect(f.order.status).toBe("PAID");
    expect(f.tx.appointmentReservation.updateMany).not.toHaveBeenCalled();
  });
  it("callback after close dispatch cannot be overwritten by a stale CLOSED result", async () => {
    const f = fixture(false);
    f.payment.closeRequestedAt = new Date();
    f.payment.closeReason = "CUSTOMER";
    f.client.queryTransaction
      .mockResolvedValueOnce(f.result("NOTPAY"))
      .mockResolvedValueOnce(f.result("CLOSED"));
    f.client.closeTransaction.mockImplementation(async () => {
      await f.payments.applyTransaction();
    });
    await f.service.recover("payment");
    expect(f.payment.status).toBe("SUCCEEDED");
    expect(f.tx.appointmentReservation.updateMany).not.toHaveBeenCalled();
  });
  it("queries after a close timeout and can resolve a channel-accepted close", async () => {
    const f = fixture();
    f.client.queryTransaction
      .mockResolvedValueOnce(f.result("NOTPAY"))
      .mockResolvedValueOnce(f.result("CLOSED", false));
    f.client.closeTransaction.mockRejectedValue(new Error("timeout"));
    await f.service.recover("payment");
    expect(f.payment.closeState).toBe("CONFIRMED");
    expect(f.payment.status).toBe("CLOSED");
  });
  it("retries only the original idempotent close after a fresh NOTPAY and backoff", async () => {
    const f = fixture();
    f.client.closeTransaction.mockRejectedValue(new Error("timeout"));
    await f.service.recover("payment");
    await f.service.recover("payment");
    expect(f.client.closeTransaction).toHaveBeenCalledOnce();
    vi.setSystemTime(f.payment.recoveryNextCheckAt);
    await f.service.recover("payment");
    expect(f.client.closeTransaction.mock.calls).toEqual([
      ["PAY123456"],
      ["PAY123456"],
    ]);
    expect(f.order.reservation.status).toBe("HOLD");
  });
  it.each([
    { out_trade_no: "other" },
    { appid: "other" },
    { amount: { total: 1, currency: "CNY" } },
    { trade_type: "NATIVE" },
  ])("identity or amount mismatch remains unresolved: %j", async (change) => {
    const f = fixture();
    f.client.queryTransaction.mockResolvedValue({
      ...f.result("CLOSED"),
      ...change,
    } as any);
    await f.service.recover("payment");
    expect(f.payment.status).toBe("PENDING");
    expect(f.client.closeTransaction).not.toHaveBeenCalled();
    expect(f.order.reservation.status).toBe("HOLD");
    expect(f.payment.recoveryFailureCode).toBe("QUERY_OR_PROTOCOL_UNCERTAIN");
  });
  it("ORDER_NOT_EXIST/signature/network failures never authorize release or new payment", async () => {
    const f = fixture();
    f.client.queryTransaction.mockRejectedValue(new Error("ORDER_NOT_EXIST"));
    await f.service.recover("payment");
    expect(f.client.closeTransaction).not.toHaveBeenCalled();
    expect(f.order.reservation.status).toBe("HOLD");
  });
  it("two concurrent instances share one persisted lease and one close", async () => {
    const f = fixture();
    let unblock!: () => void;
    const wait = new Promise<void>((r) => (unblock = r));
    f.client.queryTransaction.mockImplementation(async () => {
      await wait;
      return f.result("NOTPAY");
    });
    const first = f.service.recover("payment");
    await vi.waitUntil(() => f.client.queryTransaction.mock.calls.length === 1);
    expect(await f.service.recover("payment")).toBe(false);
    unblock();
    await first;
    expect(f.payment.recoveryAttempts).toBe(1);
    expect(f.client.closeTransaction).toHaveBeenCalledOnce();
  });
  it("stale lease results cannot release or clear the newer lease", async () => {
    const f = fixture();
    f.client.queryTransaction.mockImplementation(async () => {
      f.payment.recoveryLeaseToken = "new-owner";
      return f.result("CLOSED");
    });
    await f.service.recover("payment");
    expect(f.payment.status).toBe("PENDING");
    expect(f.payment.recoveryLeaseToken).toBe("new-owner");
  });
  it("limits recovery to 12 attempts and emits a single review event", async () => {
    const f = fixture();
    f.payment.recoveryAttempts = 11;
    await f.service.recover("payment");
    expect(f.payment.recoveryAttempts).toBe(12);
    expect(f.payment.recoveryReviewAt).toBeInstanceOf(Date);
    expect(f.tx.outboxEvent.create).toHaveBeenCalledOnce();
    await f.service.recover("payment");
    expect(f.tx.outboxEvent.create).toHaveBeenCalledOnce();
    expect(f.order.reservation.status).toBe("HOLD");
  });
  it("crash on the final attempt escalates after the lease expires without another POST", async () => {
    const f = fixture();
    f.payment.recoveryAttempts = 12;
    f.payment.recoveryLeaseToken = "crashed";
    f.payment.recoveryLeaseUntil = new Date(Date.now() - 1);
    await f.service.recover("payment");
    expect(f.payment.recoveryReviewAt).toBeInstanceOf(Date);
    expect(f.tx.outboxEvent.create).toHaveBeenCalledOnce();
    expect(f.client.queryTransaction).not.toHaveBeenCalled();
  });
  it("checks own-order authorization and the gate before a cancellation write", async () => {
    const f = fixture();
    await expect(
      f.service.closeOwnOrder({ ...f.principal, userId: "other" }, "order"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    f.client.assertRecoveryEnabled.mockImplementation(() => {
      throw new ServiceUnavailableException();
    });
    await expect(
      f.service.closeOwnOrder(f.principal, "order"),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
    expect(f.client.queryTransaction).not.toHaveBeenCalled();
  });
  it("customer cancellation records an intent but returns pending while unconfirmed", async () => {
    const f = fixture(false);
    const result = await f.service.closeOwnOrder(f.principal, "order");
    expect(result.pendingConfirmation).toBe(true);
    expect(f.payment.closeReason).toBe("CUSTOMER");
    expect(f.order.reservation.status).toBe("HOLD");
  });
  it("mock/no-payment cancellation uses the existing local path with no channel request", async () => {
    const f = fixture();
    f.payment.provider = "MOCK";
    expect(
      (await f.service.closeOwnOrder(f.principal, "order")).pendingConfirmation,
    ).toBe(false);
    expect(f.orders.cancelOwn).toHaveBeenCalledOnce();
    expect(f.client.queryTransaction).not.toHaveBeenCalled();
  });
});
