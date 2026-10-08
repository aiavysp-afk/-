"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.quoteDisplay = exports.pickSlotIndex = exports.shanghaiDate = void 0;
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
