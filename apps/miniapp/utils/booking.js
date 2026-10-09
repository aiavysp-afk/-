"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertServerQuote = exports.bookingCouponRows = exports.quoteDisplay = exports.pickSlotIndex = exports.shanghaiDate = void 0;
const shanghaiDate = (offsetDays = 0, now = Date.now()) => new Date(now + 8 * 3600000 + offsetDays * 86400000)
    .toISOString()
    .slice(0, 10);
exports.shanghaiDate = shanghaiDate;
const pickSlotIndex = (slots, preferredTherapistId, mode) => {
    if (!slots.length)
        return -1;
    if (preferredTherapistId) {
        return slots.findIndex((slot) => slot.therapistId === preferredTherapistId);
    }
    return mode === "soon" ? 0 : -1;
};
exports.pickSlotIndex = pickSlotIndex;
const quoteDisplay = (quote) => ({
    serviceAmount: (quote.serviceAmountFen / 100).toFixed(2),
    travelFee: (quote.travelFeeFen / 100).toFixed(2),
    discount: (quote.discountFen / 100).toFixed(2),
    payable: (quote.payableFen / 100).toFixed(2),
});
exports.quoteDisplay = quoteDisplay;
// Eligibility here is only explanatory. The API chooses/validates the actual
// coupon and atomically occupies it when it creates the order.
const bookingCouponRows = (coupons, serviceAmountFen, now = Date.now()) => coupons.map((coupon) => {
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
exports.bookingCouponRows = bookingCouponRows;
const assertServerQuote = (quote, reservationId) => {
    const fields = [quote.serviceAmountFen, quote.travelFeeFen, quote.discountFen, quote.payableFen];
    if (quote.reservationId !== reservationId || quote.currency !== "CNY" || quote.moneyUnit !== "fen"
        || fields.some((amount) => !Number.isSafeInteger(amount) || amount < 0)
        || quote.discountFen > quote.serviceAmountFen
        || quote.payableFen !== quote.serviceAmountFen + quote.travelFeeFen - quote.discountFen) {
        throw new Error("服务器报价核验失败，请刷新后重试");
    }
    if (quote.travelFeeFen !== 0)
        throw new Error("平台承诺技师免出行费，当前报价异常，已阻止提交");
};
exports.assertServerQuote = assertServerQuote;
