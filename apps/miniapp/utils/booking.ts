import type { AvailabilitySlot, OrderQuote } from "@zydj/contracts";

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
