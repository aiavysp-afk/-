import { ConflictException, ForbiddenException } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WechatPrepayService } from "./wechat-prepay.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
const owner: AuthPrincipal = {
  userId: "owner",
  sessionId: "session",
  displayName: "客户",
  memberships: [],
};
const friend = { ...owner, userId: "friend" };
function setup() {
  const order: any = {
    id: "order",
    organizationId: "org",
    customerId: "owner",
    status: "PENDING_PAYMENT",
    payableFen: 49800n,
    paymentExpiresAt: new Date(Date.now() + 900_000),
    payment: null,
    reservation: { status: "HOLD", expiresAt: new Date(Date.now() + 900_000) },
    items: [{ serviceName: "法式SPA" }],
  };
  const share: any = {
    id: "share",
    orderId: "order",
    expiresAt: order.paymentExpiresAt,
  };
  const tx = {
    $queryRaw: vi.fn(async () => []),
    order: { findUniqueOrThrow: vi.fn(async () => ({ ...order })) },
    friendPaymentShare: { findUnique: vi.fn(async () => share) },
    payment: {
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
        if (order.payment.prepayState !== where.prepayState)
          return { count: 0 };
        Object.assign(order.payment, data);
        return { count: 1 };
      }),
    },
    paymentEvent: { create: vi.fn(async () => ({})) },
    auditLog: { create: vi.fn(async () => ({})) },
    outboxEvent: { create: vi.fn(async () => ({})) },
  };
  let queue = Promise.resolve();
  const prisma = {
    order: { findUnique: vi.fn(async () => ({ ...order })) },
    externalIdentity: {
      findMany: vi.fn(async ({ where }: any) => [
        {
          subjectEncrypted: `openid-${where.userId}`,
          subjectHash: `hash-openid-${where.userId}`,
        },
      ]),
    },
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
    decrypt: vi.fn((value: string) => value),
    hashIdentity: vi.fn((_app: string, value: string) => `hash-${value}`),
  };
  const client = {
    assertPrepayEnabled: vi.fn(),
    prepay: vi.fn(async () => "wx-prepay"),
    paymentParameters: vi.fn(() => ({
      package: "prepay_id=wx-prepay",
      signType: "RSA",
    })),
  };
  const gateway = { buildWechatJsapiRequest: vi.fn((value) => value) };
  const config = {
    get: (key: string) => (key === "BRAND_NAME" ? "中原到家" : "wxapp"),
  };
  return {
    service: new WechatPrepayService(
      prisma as never,
      config as never,
      crypto as never,
      gateway as never,
      client as never,
    ),
    order,
    share,
    tx,
    client,
    gateway,
  };
}
describe("friend payment durable binding", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T08:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());
  it("binds one actual friend identity before external I/O and exposes SDK parameters only to that payer", async () => {
    const f = setup();
    await f.service.createFriendIntent(friend, "order", "share");
    expect(f.order.payment).toMatchObject({
      kind: "FRIEND",
      payerUserId: "friend",
      payerOpenIdHash: "hash-openid-friend",
    });
    expect(f.gateway.buildWechatJsapiRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        payerOpenId: "openid-friend",
        totalFen: 49800,
      }),
    );
    expect(f.tx.payment.create.mock.calls[0]![0].data).not.toHaveProperty(
      "payerOpenId",
    );
    await f.service.createFriendIntent(friend, "order", "share");
    await expect(
      f.service.createFriendIntent(
        { ...friend, userId: "other" },
        "order",
        "share",
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(f.service.createIntent(owner, "order")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(f.client.prepay).toHaveBeenCalledOnce();
    expect(f.client.paymentParameters).toHaveBeenCalledTimes(2);
  });
  it("only one of two different friends wins a concurrent claim", async () => {
    const f = setup();
    const results = await Promise.allSettled([
      f.service.createFriendIntent(friend, "order", "share"),
      f.service.createFriendIntent(
        { ...friend, userId: "other" },
        "order",
        "share",
      ),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(f.tx.payment.create).toHaveBeenCalledOnce();
    expect(f.client.prepay).toHaveBeenCalledOnce();
    expect(f.client.paymentParameters).toHaveBeenCalledOnce();
  });
  it("SELF and FRIEND compete on the same order lock and only one submits", async () => {
    const f = setup();
    const results = await Promise.allSettled([
      f.service.createIntent(owner, "order"),
      f.service.createFriendIntent(friend, "order", "share"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(f.client.prepay).toHaveBeenCalledOnce();
    expect(f.tx.payment.create).toHaveBeenCalledOnce();
  });
  it("refuses expired invitations under the order lock without dispatch", async () => {
    const f = setup();
    f.share.expiresAt = new Date(Date.now() - 1);
    await expect(
      f.service.createFriendIntent(friend, "order", "share"),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.tx.payment.create).not.toHaveBeenCalled();
    expect(f.client.prepay).not.toHaveBeenCalled();
  });
  it("refuses a valid invitation for a different order", async () => {
    const f = setup();
    f.share.orderId = "other-order";
    await expect(
      f.service.createFriendIntent(friend, "order", "share"),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.client.prepay).not.toHaveBeenCalled();
  });
  it("refuses the owner entering the friend endpoint", async () => {
    const f = setup();
    await expect(
      f.service.createFriendIntent(owner, "order", "share"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.client.prepay).not.toHaveBeenCalled();
  });
  it("never replaces an uncertain friend dispatch, including a different payer", async () => {
    const f = setup();
    f.client.prepay.mockRejectedValue(new Error("unknown submission"));
    await expect(
      f.service.createFriendIntent(friend, "order", "share"),
    ).rejects.toThrow("不会自动重新发起");
    const replay = await f.service.createFriendIntent(friend, "order", "share");
    expect(replay.prepayState).toBe("UNKNOWN");
    expect(replay.wechatPayParameters).toBeUndefined();
    await expect(
      f.service.createFriendIntent(
        { ...friend, userId: "other" },
        "order",
        "share",
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.client.prepay).toHaveBeenCalledOnce();
    expect(f.client.paymentParameters).not.toHaveBeenCalled();
  });
  it("persists prepay response but does not expose it after cancellation during external I/O", async () => {
    const f = setup();
    f.client.prepay.mockImplementation(async () => {
      f.order.status = "CANCELLED";
      return "wx-prepay";
    });
    await expect(
      f.service.createFriendIntent(friend, "order", "share"),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.order.payment.providerReference).toBe("wx-prepay");
    expect(f.client.paymentParameters).not.toHaveBeenCalled();
  });
  it("GET recovery returns only the existing bound friend's READY intent and never dispatches", async () => {
    const f = setup();
    await f.service.createFriendIntent(friend, "order", "share");
    const result = await f.service.readFriendIntent(friend, "order", "share");
    expect(result.wechatPayParameters).toBeDefined();
    expect(f.client.prepay).toHaveBeenCalledOnce();
    expect(f.tx.payment.create).toHaveBeenCalledOnce();
    await expect(
      f.service.readFriendIntent(
        { ...friend, userId: "other" },
        "order",
        "share",
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      f.service.readFriendIntent(owner, "order", "share"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.client.paymentParameters).toHaveBeenCalledTimes(2);
  });
  it("GET recovery never claims an unbound order and cannot return SDK parameters for UNKNOWN", async () => {
    const f = setup();
    await expect(
      f.service.readFriendIntent(friend, "order", "share"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.client.prepay).not.toHaveBeenCalled();
    expect(f.tx.payment.create).not.toHaveBeenCalled();
    f.client.prepay.mockRejectedValue(new Error("uncertain"));
    await expect(
      f.service.createFriendIntent(friend, "order", "share"),
    ).rejects.toThrow();
    expect(
      (await f.service.readFriendIntent(friend, "order", "share"))
        .wechatPayParameters,
    ).toBeUndefined();
    expect(f.client.prepay).toHaveBeenCalledOnce();
  });
  it("GET recovery never re-signs an expired two-hour prepay capability", async () => {
    const f = setup();
    await f.service.createFriendIntent(friend, "order", "share");
    f.order.payment.prepayReadyAt = new Date(Date.now() - 7_200_001);
    expect(
      (await f.service.readFriendIntent(friend, "order", "share"))
        .wechatPayParameters,
    ).toBeUndefined();
    expect(f.client.prepay).toHaveBeenCalledOnce();
    expect(f.client.paymentParameters).toHaveBeenCalledOnce();
  });
  it("GET recovery refuses an expired or cancelled order even if the original SDK capability was READY", async () => {
    const f = setup();
    await f.service.createFriendIntent(friend, "order", "share");
    f.order.status = "CANCELLED";
    await expect(
      f.service.readFriendIntent(friend, "order", "share"),
    ).rejects.toBeInstanceOf(ConflictException);
    f.order.status = "PENDING_PAYMENT";
    f.share.expiresAt = new Date(Date.now() - 1);
    await expect(
      f.service.readFriendIntent(friend, "order", "share"),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.client.paymentParameters).toHaveBeenCalledOnce();
  });
});
