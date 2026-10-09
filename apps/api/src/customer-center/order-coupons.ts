import { ConflictException } from "@nestjs/common";
import { CustomerCouponStatus, type Prisma } from "@prisma/client";

type CouponDatabase = Pick<Prisma.TransactionClient, "customerCoupon">;

export async function selectOrderCoupon(
  db: CouponDatabase,
  organizationId: string,
  customerId: string,
  serviceAmountFen: bigint,
  selectedCouponId: string | null | undefined,
  now = new Date(),
) {
  if (selectedCouponId === null) return null;
  const coupons = await db.customerCoupon.findMany({
    where: {
      organizationId,
      customerId,
      ...(selectedCouponId ? { id: selectedCouponId } : {}),
      status: CustomerCouponStatus.AVAILABLE,
      usedOrderId: null,
      validFrom: { lte: now },
      expiresAt: { gt: now },
      minimumSpendFen: { lte: serviceAmountFen },
      amountFen: { gt: 0n },
    },
    orderBy: [{ amountFen: "desc" }, { expiresAt: "asc" }, { id: "asc" }],
    take: 1,
  });
  const coupon = coupons[0] ?? null;
  if (selectedCouponId && !coupon) {
    throw new ConflictException("优惠券已失效、已被使用或未达到项目费门槛，请重新获取报价");
  }
  return coupon;
}

export async function occupyOrderCoupon(
  db: CouponDatabase,
  couponId: string,
  orderId: string,
  now: Date,
) {
  const result = await db.customerCoupon.updateMany({
    where: {
      id: couponId,
      status: CustomerCouponStatus.AVAILABLE,
      usedOrderId: null,
      validFrom: { lte: now },
      expiresAt: { gt: now },
    },
    data: { status: CustomerCouponStatus.USED, usedOrderId: orderId, usedAt: now },
  });
  if (result.count !== 1) {
    throw new ConflictException("优惠券状态已变化，请重新获取报价");
  }
}

// Call only after an unpaid order has been cancelled or a real provider closure verified.
export async function releaseOrderCoupon(
  db: CouponDatabase,
  orderId: string,
  now = new Date(),
) {
  await db.customerCoupon.updateMany({
    where: { usedOrderId: orderId, status: CustomerCouponStatus.USED, expiresAt: { gt: now } },
    data: { status: CustomerCouponStatus.AVAILABLE, usedOrderId: null, usedAt: null },
  });
  await db.customerCoupon.updateMany({
    where: { usedOrderId: orderId, status: CustomerCouponStatus.USED, expiresAt: { lte: now } },
    data: { status: CustomerCouponStatus.EXPIRED, usedOrderId: null, usedAt: null },
  });
}
