import type { DispatchBoard } from "@zydj/contracts";
import { describe, expect, it } from "vitest";
import {
  isDispatchSelectionEligible,
  reconcileDispatchSelections,
} from "./dispatch-selection";

const order: DispatchBoard["orders"][number] = {
  id: "order-1",
  orderNo: "ZY001",
  customerName: "客户",
  serviceName: "服务",
  durationMinutes: 60,
  appointmentStart: "2026-10-10T02:00:00Z",
  appointmentEnd: "2026-10-10T03:00:00Z",
  status: "PAID",
  payableFen: 28800,
  therapist: null,
  eligibleTherapists: [{ id: "tech-2", displayName: "技师二" }],
};

describe("dispatch selection after refresh", () => {
  it("clears a technician who is no longer eligible and removes departed orders", () => {
    const selections = reconcileDispatchSelections([order], {
      "order-1": "tech-1",
      "old-order": "tech-2",
    });
    expect(selections).toEqual({ "order-1": "" });
    expect(isDispatchSelectionEligible(order, selections[order.id])).toBe(
      false,
    );
  });

  it("preserves only a still eligible explicit choice", () => {
    expect(
      reconcileDispatchSelections([order], { "order-1": "tech-2" }),
    ).toEqual({ "order-1": "tech-2" });
    expect(isDispatchSelectionEligible(order, "tech-2")).toBe(true);
  });

  it("shows the actual assigned technician even after the eligible list changes", () => {
    const assigned = {
      ...order,
      status: "ASSIGNED" as const,
      therapist: { id: "tech-1", displayName: "技师一" },
      eligibleTherapists: [],
    };
    expect(
      reconcileDispatchSelections([assigned], { "order-1": "tech-2" }),
    ).toEqual({ "order-1": "tech-1" });
    expect(isDispatchSelectionEligible(assigned, "tech-1")).toBe(false);
  });
});
