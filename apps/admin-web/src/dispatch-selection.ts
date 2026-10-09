import type { DispatchBoard } from "@zydj/contracts";

export function reconcileDispatchSelections(
  orders: DispatchBoard["orders"],
  previous: Record<string, string>,
) {
  return Object.fromEntries(
    orders.map((order) => {
      if (order.status === "ASSIGNED")
        return [order.id, order.therapist?.id ?? ""];
      const selected = previous[order.id];
      const valid = order.eligibleTherapists.some(
        (therapist) => therapist.id === selected,
      );
      return [order.id, valid ? (selected ?? "") : ""];
    }),
  );
}

export function isDispatchSelectionEligible(
  order: DispatchBoard["orders"][number],
  therapistId: string | undefined,
) {
  return (
    order.status !== "ASSIGNED" &&
    order.eligibleTherapists.some((therapist) => therapist.id === therapistId)
  );
}
