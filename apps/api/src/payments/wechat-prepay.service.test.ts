import {
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WechatPrepayService } from "./wechat-prepay.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";

const principal: AuthPrincipal = {
  userId: "customer",
  sessionId: "session",
  displayName: "客户",
  memberships: [],
};
function fixture() {
  const order: any = {
    id: "order",
    organizationId: "org",
    customerId: "customer",
    status: "PENDING_PAYMENT",
    payableFen: 19880n,
    paymentExpiresAt: new Date(Date.now() + 900_000),
    payment: null,
    reservation: { status: "HOLD", expiresAt: new Date(Date.now() + 900_000) },
    items: [{ serviceName: "舒缓SPA" }],
  };
  const identities = [
    { subjectEncrypted: "cipher", subjectHash: "current-app-hash" },
  ];
  const payment = {
    create: vi.fn(async ({ data }: any) => {
      order.payment = {
        id: "payment",
        status: "PENDING",
        providerReference: null,
        prepayReadyAt: null,
        ...data,
      };
      return { ...order.payment };
    }),
    update: vi.fn(async ({ data }: any) => {
      Object.assign(order.payment, data);
      return { ...order.payment };
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      if (order.payment.prepayState !== where.prepayState) return { count: 0 };
      Object.assign(order.payment, data);
      return { count: 1 };
    }),
  };
  const tx = {
    $queryRaw: vi.fn(async () => []),
    order: { findUniqueOrThrow: vi.fn(async () => ({ ...order })) },
    payment,
    paymentEvent: { create: vi.fn(async () => ({})) },
    auditLog: { create: vi.fn(async () => ({})) },
    outboxEvent: { create: vi.fn(async () => ({})) },
  };
  let queue = Promise.resolve();
  const prisma = {
    order: { findUnique: vi.fn(async () => ({ ...order })) },
    externalIdentity: { findMany: vi.fn(async () => identities) },
    $transaction: vi.fn((callback: any) => {
      const result = queue.then(() => callback(tx));
      queue = result.then(
        () => {},
        () => {},
      );
      return result;
    }),
  };
  const crypto = {
    decrypt: vi.fn(() => "real-openid"),
    hashIdentity: vi.fn(() => "current-app-hash"),
  };
  const client = {
    assertPrepayEnabled: vi.fn(),
    prepay: vi.fn(async () => "wx-prepay-1"),
    paymentParameters: vi.fn(() => ({
      timeStamp: "123",
      nonceStr: "nonce",
      package: "prepay_id=wx-prepay-1",
      signType: "RSA",
      paySign: "signature",
    })),
  };
  const gateway = { buildWechatJsapiRequest: vi.fn((input) => input) };
  const config = {
    get: (key: string) =>
      ({ BRAND_NAME: "中原到家", WECHAT_MINIAPP_APP_ID: "current-app" })[
        key as "BRAND_NAME"
      ],
  };
  const service = new WechatPrepayService(
    prisma as never,
    config as never,
    crypto as never,
    gateway as never,
    client as never,
  );
  return { service, order, client, identities, crypto, gateway, tx };
}

describe("durable WeChat prepay", () => {
  it("never returns SDK parameters after a close request is recorded", async () => {
    const f = fixture();
    await f.service.createIntent(principal, "order");
    f.order.payment.closeRequestedAt = new Date();
    await expect(
      f.service.createIntent(principal, "order"),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.client.prepay).toHaveBeenCalledOnce();
  });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-04T00:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());
  it("claims before POST, uses server amount/identity/expiry, and reuses the stored prepay id", async () => {
    const f = fixture();
    f.client.prepay.mockImplementation(async () => {
      expect(f.order.payment.prepayState).toBe("DISPATCHING");
      return "wx-prepay-1";
    });
    const intent = await f.service.createIntent(principal, "order");
    expect(intent).toMatchObject({
      amountFen: 19880,
      prepayState: "READY",
      mockConfirmationAvailable: false,
      wechatPayParameters: { signType: "RSA" },
    });
    expect(f.gateway.buildWechatJsapiRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        totalFen: 19880,
        payerOpenId: "real-openid",
        expiresAt: f.order.paymentExpiresAt,
      }),
    );
    await f.service.createIntent(principal, "order");
    expect(f.client.prepay).toHaveBeenCalledOnce();
    expect(f.tx.paymentEvent.create).toHaveBeenCalledTimes(2);
  });
  it("only one concurrent caller dispatches", async () => {
    const f = fixture();
    await Promise.all([
      f.service.createIntent(principal, "order"),
      f.service.createIntent(principal, "order"),
    ]);
    expect(f.client.prepay).toHaveBeenCalledOnce();
    expect(f.tx.payment.create).toHaveBeenCalledOnce();
  });
  it("retains UNKNOWN after timeout and never retries POST", async () => {
    const f = fixture();
    f.client.prepay.mockRejectedValue(new Error("timeout"));
    await expect(f.service.createIntent(principal, "order")).rejects.toThrow(
      "结果未确认",
    );
    const replay = await f.service.createIntent(principal, "order");
    expect(replay.prepayState).toBe("UNKNOWN");
    expect(replay.wechatPayParameters).toBeUndefined();
    expect(f.client.prepay).toHaveBeenCalledOnce();
    expect(f.tx.outboxEvent.create).toHaveBeenCalledOnce();
  });
  it.each(["DISPATCHING", "UNKNOWN", "NONE"])(
    "does not redispatch %s including legacy records",
    async (state) => {
      const f = fixture();
      f.order.payment = {
        id: "old",
        orderId: "order",
        provider: "WECHAT",
        status: "PENDING",
        amountFen: 19880n,
        prepayState: state,
      };
      const result = await f.service.createIntent(principal, "order");
      expect(result.wechatPayParameters).toBeUndefined();
      expect(f.client.prepay).not.toHaveBeenCalled();
    },
  );
  it("forbids another customer before reading identity or dispatching", async () => {
    const f = fixture();
    f.order.customerId = "other";
    await expect(
      f.service.createIntent(principal, "order"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.crypto.decrypt).not.toHaveBeenCalled();
    expect(f.client.prepay).not.toHaveBeenCalled();
  });
  it("closed gate leaves no payment record", async () => {
    const f = fixture();
    f.client.assertPrepayEnabled.mockImplementation(() => {
      throw new ServiceUnavailableException();
    });
    await expect(
      f.service.createIntent(principal, "order"),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(f.tx.payment.create).not.toHaveBeenCalled();
  });
  it.each(["wrong-app", "mock", "broken-cipher", "missing"])(
    "refuses invalid %s identity",
    async (kind) => {
      const f = fixture();
      if (kind === "wrong-app")
        f.crypto.hashIdentity.mockReturnValue("another-app-hash");
      if (kind === "mock") f.crypto.decrypt.mockReturnValue("mock-fake");
      if (kind === "broken-cipher")
        f.crypto.decrypt.mockImplementation(() => {
          throw new Error();
        });
      if (kind === "missing") f.identities.length = 0;
      await expect(
        f.service.createIntent(principal, "order"),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(f.tx.payment.create).not.toHaveBeenCalled();
    },
  );
  it.each(["deadline", "released", "cancelled"])(
    "rejects invalid %s without POST",
    async (kind) => {
      const f = fixture();
      if (kind === "deadline")
        f.order.paymentExpiresAt = new Date(Date.now() + 60_000);
      if (kind === "released") f.order.reservation.status = "RELEASED";
      if (kind === "cancelled") f.order.status = "CANCELLED";
      await expect(
        f.service.createIntent(principal, "order"),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(f.client.prepay).not.toHaveBeenCalled();
    },
  );
  it("stores a received response but returns no SDK params if the order changes during POST", async () => {
    const f = fixture();
    f.client.prepay.mockImplementation(async () => {
      f.order.status = "CANCELLED";
      return "wx-prepay-1";
    });
    await expect(
      f.service.createIntent(principal, "order"),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.order.payment.prepayState).toBe("READY");
    expect(f.client.paymentParameters).not.toHaveBeenCalled();
  });
  it("does not turn a concurrent authoritative payment success back into PENDING", async () => {
    const f = fixture();
    f.client.prepay.mockImplementation(async () => {
      f.order.payment.status = "SUCCEEDED";
      f.order.status = "PAID";
      return "wx-prepay-1";
    });
    await expect(
      f.service.createIntent(principal, "order"),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.order.payment.status).toBe("SUCCEEDED");
    expect(f.client.paymentParameters).not.toHaveBeenCalled();
  });
});
