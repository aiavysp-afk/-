import { ConflictException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { occupyOrderCoupon, releaseOrderCoupon, selectOrderCoupon } from "./order-coupons.js";

const now = new Date("2026-10-10T10:00:00Z");
const definitions = [[4000n, 49800n], [3000n, 39800n], [2000n, 29800n], [1000n, 19800n]] as const;
function fixture() {
  const rows = definitions.map(([amountFen, minimumSpendFen], index) => ({
    id: `coupon-${index}`, organizationId: "org", customerId: "customer", amountFen,
    minimumSpendFen, status: "AVAILABLE", usedOrderId: null,
    validFrom: new Date("2026-10-01T00:00:00Z"), expiresAt: new Date("2027-01-01T00:00:00Z"),
  }));
  const findMany = vi.fn(async ({ where }: any) => rows.filter((row) =>
    row.organizationId === where.organizationId && row.customerId === where.customerId &&
    (!where.id || row.id === where.id) && row.status === where.status &&
    row.usedOrderId === null && row.validFrom <= where.validFrom.lte &&
    row.expiresAt > where.expiresAt.gt && row.minimumSpendFen <= where.minimumSpendFen.lte));
  return { rows, findMany, db: { customerCoupon: { findMany } } as never };
}

describe("server-side coupon quotation and consumption", () => {
  it.each([[19799n, 0n], [19800n, 1000n], [29799n, 1000n], [29800n, 2000n],
    [39799n, 2000n], [39800n, 3000n], [49799n, 3000n], [49800n, 4000n]])(
    "selects the best coupon for a project subtotal of %s fen", async (subtotal, discount) => {
      const f = fixture();
      const result = await selectOrderCoupon(f.db, "org", "customer", subtotal, undefined, now);
      expect(result?.amountFen ?? 0n).toBe(discount);
      expect(f.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ minimumSpendFen: { lte: subtotal } }),
      }));
    });

  it("never applies coupons owned by another user, in another organization, expired or occupied", async () => {
    const f = fixture();
    f.rows[0]!.customerId = "someone-else";
    f.rows[1]!.organizationId = "another-org";
    f.rows[2]!.expiresAt = new Date("2026-10-09T00:00:00Z");
    f.rows[3]!.status = "USED";
    expect(await selectOrderCoupon(f.db, "org", "customer", 49800n, undefined, now)).toBeNull();
  });

  it("honors explicit no-coupon selection and rejects unavailable quote coupons", async () => {
    const f = fixture();
    expect(await selectOrderCoupon(f.db, "org", "customer", 49800n, null, now)).toBeNull();
    expect(f.findMany).not.toHaveBeenCalled();
    await expect(selectOrderCoupon(f.db, "org", "customer", 19800n, "coupon-0", now))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it("rejects a second order racing to occupy the same coupon", async () => {
    const updateMany = vi.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const db = { customerCoupon: { updateMany } } as never;
    await occupyOrderCoupon(db, "coupon", "order-a", now);
    await expect(occupyOrderCoupon(db, "coupon", "order-b", now)).rejects.toBeInstanceOf(ConflictException);
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: "AVAILABLE", usedOrderId: null }),
      data: { status: "USED", usedOrderId: "order-a", usedAt: now },
    }));
  });

  it("restores only an unpaid cancelled order's coupon and expires past-validity coupons", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    await releaseOrderCoupon({ customerCoupon: { updateMany } } as never, "order-a", now);
    expect(updateMany).toHaveBeenCalledWith({
      where: { usedOrderId: "order-a", status: "USED", expiresAt: { gt: now } },
      data: { status: "AVAILABLE", usedOrderId: null, usedAt: null },
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { usedOrderId: "order-a", status: "USED", expiresAt: { lte: now } },
      data: { status: "EXPIRED", usedOrderId: null, usedAt: null },
    });
  });
});
