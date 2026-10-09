import { describe, expect, it } from "vitest";
import { technicianShiftSummary } from "./shift-summary";

const shift = {
  id: "shift-1",
  status: "ACTIVE" as const,
  startsAt: "2026-10-10T01:00:00Z",
  endsAt: "2026-10-10T09:00:00Z",
};

describe("server-timed technician shifts", () => {
  it("uses the real current shift, including its start and excluding its end", () => {
    expect(technicianShiftSummary([shift], shift.startsAt)).toBe("当前在班");
    expect(technicianShiftSummary([shift], shift.endsAt)).toBe(
      "当前无有效班次",
    );
  });
  it("only calls an upcoming active shift scheduled", () => {
    expect(technicianShiftSummary([shift], "2026-10-10T00:00:00Z")).toBe(
      "已排班，等待班次",
    );
    expect(
      technicianShiftSummary(
        [{ ...shift, status: "CANCELLED" }],
        "2026-10-10T02:00:00Z",
      ),
    ).toBe("当前无有效班次");
  });
  it("does not invent a shift for an empty roster", () => {
    expect(technicianShiftSummary([], "2026-10-10T02:00:00Z")).toBe(
      "当前无有效班次",
    );
  });
});
