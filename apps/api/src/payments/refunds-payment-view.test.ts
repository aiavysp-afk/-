import { ForbiddenException } from "@nestjs/common";
import type { UserRole } from "@prisma/client";
import { AdminPaymentViewSchema } from "@zydj/contracts";
import { describe, expect, it, vi } from "vitest";
import { AccessControlService } from "../auth/access-control.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { OrderStateMachine } from "../orders/order-state-machine.js";
import { RefundsService } from "./refunds.service.js";

const succeededAt = new Date("2026-10-09T09:30:00.000Z");
const record = {
  id: "payment-1",
  orderId: "order-1",
  order: { orderNo: "ZY001", status: "PAID" },
  status: "SUCCEEDED",
  provider: "WECHAT",
  kind: "FRIEND",
  payer: {
    id: "payer-1",
    displayName: "微信好友",
    phoneEncrypted: "encrypted-phone-must-not-escape",
    authIdentities: [{ openId: "openid-must-not-escape" }],
  },
  succeededAt,
  failureCode: null,
  recoveryReviewAt: null,
  amountFen: 19800n,
  refundReservedFen: 0n,
  refundedFen: 0n,
  payerOpenIdHash: "payer-hash-must-not-escape",
  prepayId: "prepay-token-must-not-escape",
};

function principal(
  role: UserRole = "FINANCE_REQUESTER",
  organizationId = "org-1",
  mfaVerifiedUntil: Date | undefined = new Date(Date.now() + 60000),
): AuthPrincipal {
  return {
    userId: "staff-1",
    sessionId: "session-1",
    displayName: "组织财务",
    memberships: [{ organizationId, role }],
    mfaVerifiedUntil,
  };
}

function setup(rows: object[] = [record]) {
  const prisma = {
    payment: { findMany: vi.fn().mockResolvedValue(rows) },
    order: { findUnique: vi.fn() },
    refund: { findFirst: vi.fn() },
  };
  const access = new AccessControlService({ get: () => "production" } as never);
  const service = new RefundsService(
    prisma as never,
    access,
    { get: () => "production" } as never,
    {} as never,
    new OrderStateMachine(),
  );
  return { service, prisma };
}

describe("organization finance payment payer serialization", () => {
  it("returns the actual friend payer with safe money and a success timestamp", async () => {
    const { service, prisma } = setup();
    const result = await service.listPayments(principal(), "org-1");
    expect(AdminPaymentViewSchema.array().parse(result)).toEqual([
      {
        id: "payment-1",
        orderId: "order-1",
        orderNo: "ZY001",
        orderStatus: "PAID",
        status: "SUCCEEDED",
        provider: "WECHAT",
        kind: "FRIEND",
        payer: { userId: "payer-1", displayName: "微信好友" },
        succeededAt: succeededAt.toISOString(),
        failureCode: null,
        recoveryReviewAt: null,
        reviewRequired: false,
        amountFen: 19800,
        reservedFen: 0,
        refundedFen: 0,
        availableFen: 19800,
      },
    ]);
    expect(prisma.payment.findMany).toHaveBeenCalledWith({
      where: { order: { organizationId: "org-1" } },
      select: {
        id: true,
        orderId: true,
        order: { select: { orderNo: true, status: true } },
        status: true,
        provider: true,
        kind: true,
        payer: { select: { id: true, displayName: true } },
        succeededAt: true,
        failureCode: true,
        recoveryReviewAt: true,
        amountFen: true,
        refundReservedFen: true,
        refundedFen: true,
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(
      /openid|payerOpenIdHash|phone|prepay|token/i,
    );
    expect(serialized).not.toContain("must-not-escape");
  });

  it("keeps a pending friend's identity separate from actual success", async () => {
    const { service } = setup([
      { ...record, status: "PENDING", succeededAt: null },
    ]);
    await expect(service.listPayments(principal(), "org-1")).resolves.toEqual([
      expect.objectContaining({
        kind: "FRIEND",
        status: "PENDING",
        payer: { userId: "payer-1", displayName: "微信好友" },
        succeededAt: null,
      }),
    ]);
  });

  it("preserves legacy self payments without fabricating payer information", async () => {
    const { service } = setup([
      { ...record, kind: "SELF", payer: null, succeededAt: null },
    ]);
    await expect(service.listPayments(principal(), "org-1")).resolves.toEqual([
      expect.objectContaining({ kind: "SELF", payer: null, succeededAt: null }),
    ]);
  });

  it.each([
    ["SUCCEEDED", "FULFILLMENT_REVIEW_REQUIRED", null, 0n, true],
    ["REFUNDING", "FULFILLMENT_REVIEW_REQUIRED", null, 100n, true],
    ["REFUNDED", "FULFILLMENT_REVIEW_REQUIRED", null, 19800n, false],
    ["SUCCEEDED", "FULFILLMENT_REVIEW_REQUIRED", null, 19800n, false],
    ["PENDING", null, succeededAt, 0n, true],
    ["CLOSED", null, succeededAt, 0n, false],
  ])(
    "marks %s payments for review only while unresolved",
    async (
      status,
      failureCode,
      recoveryReviewAt,
      refundedFen,
      reviewRequired,
    ) => {
      const { service } = setup([
        { ...record, status, failureCode, recoveryReviewAt, refundedFen },
      ]);
      const [result] = await service.listPayments(principal(), "org-1");
      expect(result).toMatchObject({
        failureCode,
        recoveryReviewAt:
          recoveryReviewAt instanceof Date
            ? recoveryReviewAt.toISOString()
            : null,
        reviewRequired,
      });
    },
  );

  it.each(["ADMIN", "FINANCE_APPROVER", "FINANCE_REQUESTER"] as UserRole[])(
    "allows %s only within the authorized organization after MFA",
    async (role) => {
      const { service, prisma } = setup();
      await expect(
        service.listPayments(principal(role), "org-1"),
      ).resolves.toHaveLength(1);
      await expect(
        service.listPayments(principal(role), "other-org"),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.payment.findMany).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["CUSTOMER", "THERAPIST", "OPERATOR", "DISPATCHER"] as UserRole[])(
    "does not disclose payer information to %s",
    async (role) => {
      const { service, prisma } = setup();
      await expect(
        service.listPayments(principal(role), "org-1"),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.payment.findMany).not.toHaveBeenCalled();
    },
  );

  it("requires unexpired MFA before reading the payment list", async () => {
    const { service, prisma } = setup();
    await expect(
      service.listPayments(principal("ADMIN", "org-1", new Date(0)), "org-1"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const missingMfa = principal("ADMIN");
    delete missingMfa.mfaVerifiedUntil;
    await expect(
      service.listPayments(missingMfa, "org-1"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.payment.findMany).not.toHaveBeenCalled();
  });

  it("does not let the friend payer request a refund for the owner's order", async () => {
    const { service, prisma } = setup();
    prisma.order.findUnique.mockResolvedValue({
      id: "order-1",
      customerId: "order-owner-1",
      organizationId: "org-1",
      payment: { ...record, payerUserId: "payer-1" },
    });
    await expect(
      service.requestOwn(
        { ...principal("CUSTOMER"), userId: "payer-1" },
        "order-1",
        "friend-refund-idempotency-key",
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.refund.findFirst).not.toHaveBeenCalled();
  });
});
