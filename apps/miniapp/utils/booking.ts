import type { AvailabilitySlot, CustomerCoupon, OrderQuote } from "@zydj/contracts";

export type AppointmentMode = "soon" | "schedule";

export const shanghaiDate = (offsetDays = 0, now = Date.now()) =>
  new Date(now + 8 * 3_600_000 + offsetDays * 86_400_000)
    .toISOString()
    .slice(0, 10);

export const pickSlotIndex = (
  slots: AvailabilitySlot[],
  preferredTherapistId: string,
  mode: AppointmentMode,
) => {
  if (!slots.length) return -1;
  if (preferredTherapistId) {
    return slots.findIndex(
      (slot) => slot.therapistId === preferredTherapistId,
    );
  }
  return mode === "soon" ? 0 : -1;
};

export const quoteDisplay = (quote: OrderQuote) => ({
  serviceAmount: (quote.serviceAmountFen / 100).toFixed(2),
  travelFee: (quote.travelFeeFen / 100).toFixed(2),
  discount: (quote.discountFen / 100).toFixed(2),
  payable: (quote.payableFen / 100).toFixed(2),
});

// Eligibility here is only explanatory. The API chooses/validates the actual
// coupon and atomically occupies it when it creates the order.
export const bookingCouponRows = (
  coupons: CustomerCoupon[],
  serviceAmountFen: number,
  now = Date.now(),
) => coupons.map((coupon) => {
  const reason = !Number.isFinite(Date.parse(coupon.validFrom)) || !Number.isFinite(Date.parse(coupon.expiresAt)) ? "有效期信息异常"
    : coupon.status === "USED" ? "已使用"
    : coupon.status === "EXPIRED" || Date.parse(coupon.expiresAt) <= now ? "已过期"
    : Date.parse(coupon.validFrom) > now ? "尚未到使用时间"
    : coupon.amountFen <= 0 ? "优惠券金额无效"
    : coupon.minimumSpendFen > serviceAmountFen
      ? `项目费满 ¥${(coupon.minimumSpendFen / 100).toFixed(2)} 可用`
      : "";
  return {
    ...coupon,
    amount: (coupon.amountFen / 100).toFixed(2),
    threshold: `项目费满 ¥${(coupon.minimumSpendFen / 100).toFixed(2)} 可用`,
    validity: coupon.expiresAt.slice(0, 10),
    scope: coupon.canApplyToTravelFee ? "可抵项目费及出行费（本单免出行费）" : "仅抵项目费，不抵出行费",
    eligible: !reason,
    reason,
  };
});

export const assertServerQuote = (quote: OrderQuote, reservationId: string) => {
  const fields = [quote.serviceAmountFen, quote.travelFeeFen, quote.discountFen, quote.payableFen];
  if (quote.reservationId !== reservationId || quote.currency !== "CNY" || quote.moneyUnit !== "fen"
    || fields.some((amount) => !Number.isSafeInteger(amount) || amount < 0)
    || quote.discountFen > quote.serviceAmountFen
    || quote.payableFen !== quote.serviceAmountFen + quote.travelFeeFen - quote.discountFen) {
    throw new Error("服务器报价核验失败，请刷新后重试");
  }
  if (quote.travelFeeFen !== 0) throw new Error("平台承诺技师免出行费，当前报价异常，已阻止提交");
};
