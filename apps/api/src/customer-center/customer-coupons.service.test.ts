import { ForbiddenException } from "@nestjs/common";
import type { CustomerCoupon } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { CustomerCouponsService } from "./customer-coupons.service.js";

const principal: AuthPrincipal = {
  userId: "customer", sessionId: "session", displayName: "客户", memberships: [],
};
const now = new Date("2026-10-10T10:00:00Z");

function fixture(verified = true) {
  const rows: CustomerCoupon[] = [];
  const user = {
    status: "ACTIVE", phoneEncrypted: verified ? "encrypted" : null,
    phoneVerifiedAt: verified ? now : null,
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    user: { findUnique: vi.fn(async () => user) },
    customerCoupon: {
      findMany: vi.fn(async () => [...rows]),
      create: vi.fn(async ({ data }) => {
        const row = {
          ...data, id: `coupon-${rows.length}`, status: "AVAILABLE", usedAt: null,
          usedOrderId: null, createdAt: now, updatedAt: now,
        } as CustomerCoupon;
        rows.push(row);
        return row;
      }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  let queue = Promise.resolve();
  const prisma = {
    ...tx,
    order: { findFirst: vi.fn().mockResolvedValue(null) },
    service: { findFirst: vi.fn().mockResolvedValue({ organizationId: "org" }) },
    $transaction: vi.fn((callback: (db: typeof tx) => unknown) => {
      const result = queue.then(() => callback(tx));
      queue = result.then(() => undefined, () => undefined);
      return result;
    }),
  };
  return { rows, tx, prisma, service: new CustomerCouponsService(prisma as never) };
}

describe("manual newcomer coupon bundle", () => {
  it("only reads eligibility on home load and never creates coupons", async () => {
    const f = fixture();
    await expect(f.service.newcomerOffer(principal, undefined, now)).resolves.toMatchObject({
      organizationId: "org", claimed: false, eligible: true, coupons: [],
    });
    expect(f.tx.customerCoupon.create).not.toHaveBeenCalled();
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("manually issues exactly four project-only coupons with requested thresholds", async () => {
    const f = fixture();
    const result = await f.service.claimNewcomerCoupons(principal, undefined, now);
    expect(result).toMatchObject({ claimed: true, eligible: false, idempotentReplay: false });
    expect(result.coupons.map(({ amountFen, minimumSpendFen, canApplyToTravelFee }) =>
      [amountFen, minimumSpendFen, canApplyToTravelFee])).toEqual([
        [4000, 49800, false], [3000, 39800, false], [2000, 29800, false], [1000, 19800, false],
      ]);
    expect(result.coupons.every(({ expiresAt }) => expiresAt === "2027-01-08T10:00:00.000Z")).toBe(true);
    expect(f.tx.auditLog.create).toHaveBeenCalledOnce();
    expect(f.tx.$queryRaw).toHaveBeenCalledOnce();
  });

  it("concurrent and repeated manual claims grant only one bundle", async () => {
    const f = fixture();
    const results = await Promise.all([
      f.service.claimNewcomerCoupons(principal, undefined, now),
      f.service.claimNewcomerCoupons(principal, undefined, now),
    ]);
    expect(f.rows).toHaveLength(4);
    expect(results.map(({ idempotentReplay }) => idempotentReplay)).toEqual([false, true]);
    expect(f.tx.auditLog.create).toHaveBeenCalledOnce();
  });

  it("blocks claims before mobile verification", async () => {
    const f = fixture(false);
    await expect(f.service.newcomerOffer(principal, undefined, now)).resolves.toMatchObject({
      claimed: false, eligible: false,
    });
    await expect(f.service.claimNewcomerCoupons(principal, undefined, now))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(f.rows).toHaveLength(0);
  });

  it("does not grant a replacement bundle after original coupons expire", async () => {
    const f = fixture();
    await f.service.claimNewcomerCoupons(principal, undefined, now);
    const result = await f.service.claimNewcomerCoupons(principal, undefined,
      new Date("2027-02-01T10:00:00Z"));
    expect(result.idempotentReplay).toBe(true);
    expect(result.coupons.every(({ status }) => status === "EXPIRED")).toBe(true);
    expect(f.rows).toHaveLength(4);
  });
});
