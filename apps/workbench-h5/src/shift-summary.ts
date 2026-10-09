import type { TechnicianWorkbenchShift } from "@zydj/contracts";

export function technicianShiftSummary(
  shifts: TechnicianWorkbenchShift[],
  generatedAt: string,
) {
  const now = Date.parse(generatedAt);
  const active = shifts.filter((shift) => shift.status === "ACTIVE");
  if (
    active.some(
      (shift) =>
        Date.parse(shift.startsAt) <= now && Date.parse(shift.endsAt) > now,
    )
  ) {
    return "当前在班";
  }
  if (active.some((shift) => Date.parse(shift.startsAt) > now))
    return "已排班，等待班次";
  return "当前无有效班次";
}
