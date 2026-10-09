import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FriendPaymentsService } from "./friend-payments.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";

const owner: AuthPrincipal = {
  userId: "owner",
  sessionId: "session",
  displayName: "下单人",
  memberships: [],
};
const friend = { ...owner, userId: "friend" };
const token = "A".repeat(43);
function setup() {
  const order: any = {
    id: "order",
    customerId: "owner",
    organizationId: "org",
    status: "PENDING_PAYMENT",
    payableFen: 49800n,
    paymentExpiresAt: new Date(Date.now() + 900_000),
    appointmentStart: new Date(Date.now() + 3600_000),
    organization: { name: "中原到家" },
    items: [{ serviceName: "法式SPA", durationMinutes: 120, quantity: 1 }],
    reservation: { status: "HOLD", expiresAt: new Date(Date.now() + 900_000) },
    payment: null,
    addressEncrypted: "secret address",
    addressLatitude: 34,
    addressLongitude: 113,
    phoneEncrypted: "secret phone",
  };
  const share = {
    id: "share",
    orderId: "order",
    expiresAt: order.paymentExpiresAt,
    order,
  };
  const prisma = {
    order: {
      findUnique: vi.fn(async () => order),
      findUniqueOrThrow: vi.fn(async () => order),
    },
    friendPaymentShare: {
      create: vi.fn(async ({ data }: any) => ({ id: "share", ...data })),
      findUnique: vi.fn(async (_query: any) => share),
    },
    orderEvent: {
      findMany: vi.fn(async (_query: any) => [
        {
          id: "event",
          orderId: "order",
          type: "FRIEND_PAYMENT_SUCCEEDED",
          createdAt: new Date(),
        },
      ]),
    },
    auditLog: { create: vi.fn(async () => ({})) },
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation((callback: any) => callback(prisma));
  const config = { get: vi.fn(() => "wechat") };
  const client = { assertPrepayEnabled: vi.fn() };
  const prepay = { createFriendIntent: vi.fn(async () => ({ id: "payment" })) };
  const wechat = {
    reconcileFriend: vi.fn(async () => ({
      id: "payment",
      status: "SUCCEEDED",
    })),
  };
  const service = new FriendPaymentsService(
    prisma as never,
    config as never,
    client as never,
    prepay as never,
    wechat as never,
  );
  return { service, order, share, prisma, client, config, prepay, wechat };
}
describe("friend payment shares and privacy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T08:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());
  it("mints an owner-only 256-bit capability and persists only its digest under the order lock", async () => {
    const f = setup();
    const result = await f.service.createShare(owner, "order");
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.miniappPath).toBe(
      `/pages/friend-payment/index?token=${result.token}`,
    );
    expect(result.amountFen).toBe(49800);
    expect(f.prisma.$queryRaw).toHaveBeenCalledOnce();
    const data = f.prisma.friendPaymentShare.create.mock.calls[0]![0].data;
    expect(data.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(data)).not.toContain(result.token);
    expect(JSON.stringify(f.prisma.auditLog.create.mock.calls)).not.toContain(
      result.token,
    );
  });
  it("refuses a non-owner before any capability is written", async () => {
    const f = setup();
    await expect(f.service.createShare(friend, "order")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(f.prisma.friendPaymentShare.create).not.toHaveBeenCalled();
  });
  it.each([
    "PAID",
    "CANCELLED",
    "EXPIRED",
    "RELEASED",
    "NO_HOLD",
    "NEAR_DEADLINE",
  ])("does not share %s orders", async (state) => {
    const f = setup();
    if (state === "PAID" || state === "CANCELLED") f.order.status = state;
    if (state === "EXPIRED")
      f.order.paymentExpiresAt = new Date(Date.now() - 1);
    if (state === "RELEASED") f.order.reservation.status = "RELEASED";
    if (state === "NO_HOLD") f.order.reservation = null;
    if (state === "NEAR_DEADLINE")
      f.order.paymentExpiresAt = new Date(Date.now() + 60_000);
    await expect(f.service.createShare(owner, "order")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(f.prisma.friendPaymentShare.create).not.toHaveBeenCalled();
  });
  it("refuses to replace an existing SELF or FRIEND prepay claim", async () => {
    for (const kind of ["SELF", "FRIEND"]) {
      const f = setup();
      f.order.payment = { id: "payment", kind, status: "PENDING" };
      await expect(f.service.createShare(owner, "order")).rejects.toThrow(
        "不能改为好友代付",
      );
    }
  });
  it.each(["mock", "disabled"])(
    "does not pretend %s supports real friend payments",
    async (kind) => {
      const f = setup();
      if (kind === "mock") f.config.get.mockReturnValue("mock");
      else
        f.client.assertPrepayEnabled.mockImplementation(() => {
          throw new ServiceUnavailableException();
        });
      await expect(
        f.service.createShare(owner, "order"),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(f.prisma.friendPaymentShare.create).not.toHaveBeenCalled();
      expect((await f.service.summary(friend, token)).canPay).toBe(false);
    },
  );
  it("returns only whitelisted service summary, never customer, phone, address, coordinates or order number", async () => {
    const f = setup();
    const result = await f.service.summary(friend, token);
    expect(result).toMatchObject({
      state: "PENDING_PAYMENT",
      amountFen: 49800,
      canPay: true,
      isOrderOwner: false,
      serviceProviderName: "中原到家",
    });
    expect(Object.keys(result).sort()).toEqual(
      [
        "state",
        "isOrderOwner",
        "paymentClaimedByYou",
        "canPay",
        "serviceItems",
        "serviceProviderName",
        "appointmentAt",
        "amountFen",
        "expiresAt",
        "rightsNotice",
      ].sort(),
    );
    const query = f.prisma.friendPaymentShare.findUnique.mock
      .calls[0]![0] as any;
    expect(query.select.order.select.addressEncrypted).toBeUndefined();
    expect(query.select.order.select.customer).toBeUndefined();
    expect(result.rightsNotice).toContain("原路退回实际微信付款账户");
  });
  it("does not allow the order owner to masquerade as a friend", async () => {
    const f = setup();
    expect(await f.service.summary(owner, token)).toMatchObject({
      isOrderOwner: true,
      canPay: false,
    });
  });
  it.each(["paid", "cancelled", "expired", "other_payer", "self", "closing"])(
    "disables %s summaries",
    async (state) => {
      const f = setup();
      if (state === "paid") f.order.status = "PAID";
      if (state === "cancelled") f.order.status = "CANCELLED";
      if (state === "expired") f.share.expiresAt = new Date(Date.now() - 1);
      if (state === "other_payer")
        f.order.payment = {
          kind: "FRIEND",
          payerUserId: "other",
          status: "PENDING",
        };
      if (state === "self")
        f.order.payment = {
          kind: "SELF",
          payerUserId: "owner",
          status: "PENDING",
        };
      if (state === "closing")
        f.order.payment = {
          kind: "FRIEND",
          payerUserId: "friend",
          status: "PENDING",
          closeRequestedAt: new Date(),
        };
      expect((await f.service.summary(friend, token)).canPay).toBe(false);
    },
  );
  it("allows only the same bound friend to reuse the existing prepay", async () => {
    const f = setup();
    f.order.payment = {
      id: "payment",
      kind: "FRIEND",
      payerUserId: "friend",
      status: "PENDING",
    };
    expect(await f.service.summary(friend, token)).toMatchObject({
      canPay: true,
      paymentClaimedByYou: true,
    });
    await f.service.createIntent(friend, token);
    expect(f.prepay.createFriendIntent).toHaveBeenCalledWith(
      friend,
      "order",
      "share",
    );
  });
  it("will reconcile an expired invitation only for its bound payer and never for the owner or another friend", async () => {
    const f = setup();
    f.share.expiresAt = new Date(Date.now() - 1);
    f.order.payment = {
      id: "payment",
      kind: "FRIEND",
      payerUserId: "friend",
      status: "PENDING",
    };
    await expect(f.service.createIntent(friend, token)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(f.service.reconcile(owner, token)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      f.service.reconcile({ ...friend, userId: "other" }, token),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await f.service.reconcile(friend, token);
    expect(f.wechat.reconcileFriend).toHaveBeenCalledOnce();
  });
  it.each(["", "short", "x".repeat(44), "../" + "x".repeat(40)])(
    "rejects malformed share capabilities before database access",
    async (value) => {
      const f = setup();
      await expect(f.service.summary(friend, value)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(f.prisma.friendPaymentShare.findUnique).not.toHaveBeenCalled();
    },
  );
  it("hides ordinary success notices with deleted history and scopes every notice to the owner", async () => {
    const f = setup();
    const result = await f.service.notifications(owner);
    expect(f.prisma.orderEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          order: { customerId: "owner" },
          OR: [
            {
              type: "FRIEND_PAYMENT_SUCCEEDED",
              order: { customerHiddenAt: null },
            },
            { type: "FRIEND_PAYMENT_FULFILLMENT_REVIEW_REQUIRED" },
          ],
        }),
      }),
    );
    expect(result[0]).toMatchObject({
      title: "好友代付成功",
      orderId: "order",
    });
    expect(result[0]).not.toHaveProperty("payerUserId");
  });
  it("shows a hidden cancelled order's late money receipt only to its owner without restoring service or exposing private data", async () => {
    const f = setup();
    const hiddenAt = new Date(Date.now() - 60_000);
    f.order.status = "CANCELLED";
    f.order.customerHiddenAt = hiddenAt;
    f.order.payment = {
      kind: "FRIEND",
      status: "SUCCEEDED",
      failureCode: "FULFILLMENT_REVIEW_REQUIRED",
    };
    const events = [
      {
        id: "late-receipt",
        orderId: "order",
        type: "FRIEND_PAYMENT_FULFILLMENT_REVIEW_REQUIRED",
        createdAt: new Date(),
        order: { customerId: "owner", customerHiddenAt: hiddenAt },
        payerUserId: "friend-private",
        payerOpenIdHash: "private-hash",
        phoneEncrypted: "private-phone",
        addressEncrypted: "private-address",
      },
      {
        id: "hidden-success",
        orderId: "order",
        type: "FRIEND_PAYMENT_SUCCEEDED",
        createdAt: new Date(),
        order: { customerId: "owner", customerHiddenAt: hiddenAt },
      },
      {
        id: "other-owner-receipt",
        orderId: "other-order",
        type: "FRIEND_PAYMENT_FULFILLMENT_REVIEW_REQUIRED",
        createdAt: new Date(),
        order: { customerId: "other", customerHiddenAt: hiddenAt },
      },
    ];
    f.prisma.orderEvent.findMany.mockImplementation(async (query: any) => {
      expect(query.select).toEqual({
        id: true,
        orderId: true,
        type: true,
        createdAt: true,
      });
      return events.filter(
        (event) =>
          event.order.customerId === query.where.order.customerId &&
          query.where.OR.some(
            (clause: any) =>
              event.type === clause.type &&
              (!clause.order ||
                event.order.customerHiddenAt === clause.order.customerHiddenAt),
          ),
      );
    });
    const result = await f.service.notifications(owner);
    expect(result).toEqual([
      {
        id: "late-receipt",
        orderId: "order",
        createdAt: new Date().toISOString(),
        title: "好友代付已到账，服务需核实",
        body: "微信付款已确认，但原预约已失效或订单已取消，请联系平台核实服务或原路退款。",
      },
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /private|payer|customerHiddenAt/,
    );
    expect(f.order.status).toBe("CANCELLED");
    expect(f.order.customerHiddenAt).toBe(hiddenAt);
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
    expect(f.prisma.$queryRaw).not.toHaveBeenCalled();
  });
});
