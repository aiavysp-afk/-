import { describe, expect, it, vi } from "vitest";
import {
  buildSchedulingShift,
  createSchedulingRequests,
  runSchedulingOperation,
  validSchedulingDate,
} from "./scheduling-workspace-state";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("scheduling request scope", () => {
  it("distinguishes date A -> B -> A and every identity or organization change before cleanup", () => {
    const requests = createSchedulingRequests();
    const firstA = requests.select("session-a", "org-a", "2026-10-18");
    const old = requests.begin(firstA);
    expect(old()).toBe(true);
    const b = requests.select("session-a", "org-a", "2026-10-19");
    expect(old()).toBe(false);
    const bRead = requests.begin(b);
    const secondA = requests.select("session-a", "org-a", "2026-10-18");
    expect(secondA).not.toBe(firstA);
    expect(bRead()).toBe(false);
    const newRead = requests.begin(secondA);
    // Calling an obsolete closure must not invalidate the current request.
    expect(requests.begin(firstA)()).toBe(false);
    expect(newRead()).toBe(true);
    requests.select("session-b", "org-a", "2026-10-18");
    expect(newRead()).toBe(false);
    const current = requests.begin(
      requests.select("session-b", "org-a", "2026-10-18"),
    );
    requests.select("session-b", "org-b", "2026-10-18");
    expect(current()).toBe(false);
  });

  it.each(["resolve", "reject"] as const)(
    "old %s cannot set rows/error or clear a newer busy state",
    async (result) => {
      const requests = createSchedulingRequests();
      const scope = requests.select("session", "org", "2026-10-18");
      const old = deferred<string>();
      const effects = { success: vi.fn(), failure: vi.fn(), finish: vi.fn() };
      const running = runSchedulingOperation({
        isCurrent: requests.begin(scope),
        execute: () => old.promise,
        ...effects,
      });
      const newRequest = requests.begin(scope);
      if (result === "resolve") old.resolve("old rows");
      else old.reject(new Error("old error"));
      await running;
      expect(newRequest()).toBe(true);
      for (const effect of Object.values(effects))
        expect(effect).not.toHaveBeenCalled();
    },
  );

  it("never executes an old-date mutation and invalidates effects on unmount", async () => {
    const requests = createSchedulingRequests();
    const a = requests.select("session", "org", "2026-10-18");
    requests.select("session", "org", "2026-10-19");
    const execute = vi.fn(async () => "must not execute");
    const effects = { success: vi.fn(), failure: vi.fn(), finish: vi.fn() };
    await runSchedulingOperation({
      isCurrent: requests.begin(a),
      execute,
      ...effects,
    });
    expect(execute).not.toHaveBeenCalled();
    const pending = deferred<string>();
    const scope = requests.select("session", "org", "2026-10-19");
    const running = runSchedulingOperation({
      isCurrent: requests.begin(scope),
      execute: () => pending.promise,
      ...effects,
    });
    requests.invalidate();
    pending.resolve("late reply");
    await running;
    for (const effect of Object.values(effects))
      expect(effect).not.toHaveBeenCalled();
  });

  it("runs a current failure and finally exactly once without treating it as an empty success", async () => {
    const requests = createSchedulingRequests();
    const scope = requests.select("session", "org", "2026-10-18");
    const effects = { success: vi.fn(), failure: vi.fn(), finish: vi.fn() };
    await runSchedulingOperation({
      isCurrent: requests.begin(scope),
      execute: async () => {
        throw new Error("unavailable");
      },
      ...effects,
    });
    expect(effects.success).not.toHaveBeenCalled();
    expect(effects.failure).toHaveBeenCalledOnce();
    expect(effects.finish).toHaveBeenCalledOnce();
  });
});

const draft = {
  date: "2026-10-18",
  organizationId: "org-a",
  therapistId: "tech-a",
  startsAt: "2026-10-18T09:00",
  endsAt: "2026-10-18T18:00",
};
const authorized = { ready: true, busy: false, technicianIds: ["tech-a"] };
describe("scheduling mutation snapshot", () => {
  it("builds only the selected day, current organization and current technician's server payload", () => {
    expect(buildSchedulingShift(draft, authorized)).toEqual({
      organizationId: "org-a",
      therapistId: "tech-a",
      startsAt: "2026-10-18T01:00:00.000Z",
      endsAt: "2026-10-18T10:00:00.000Z",
    });
  });
  it("does not submit before current rows load, during a mutation, for a former organization technician or old date", () => {
    expect(
      buildSchedulingShift(draft, { ...authorized, ready: false }),
    ).toBeNull();
    expect(
      buildSchedulingShift(draft, { ...authorized, busy: true }),
    ).toBeNull();
    expect(
      buildSchedulingShift(draft, { ...authorized, technicianIds: ["tech-b"] }),
    ).toBeNull();
    expect(
      buildSchedulingShift({ ...draft, date: "2026-10-19" }, authorized),
    ).toBeNull();
    expect(
      buildSchedulingShift({ ...draft, organizationId: "" }, authorized),
    ).toBeNull();
    expect(
      buildSchedulingShift({ ...draft, therapistId: "" }, authorized),
    ).toBeNull();
  });
  it("rejects invalid calendar/local time input and reverse or equal boundaries without throwing", () => {
    for (const value of [
      "",
      "2026-02-30",
      "2026-13-01",
      "2026-10-18T00:00",
      "not-a-date",
    ])
      expect(validSchedulingDate(value)).toBe(false);
    for (const value of [
      "2026-10-18T24:00",
      "2026-10-18T09:99",
      "2026-10-18T09:00:00",
      "2026-02-30T09:00",
      "invalid",
    ])
      expect(
        buildSchedulingShift({ ...draft, startsAt: value }, authorized),
      ).toBeNull();
    for (const value of [draft.startsAt, "2026-10-17T18:00", "invalid"])
      expect(
        buildSchedulingShift({ ...draft, endsAt: value }, authorized),
      ).toBeNull();
  });
  it("retains valid overnight shifts starting on the selected day", () => {
    expect(
      buildSchedulingShift(
        { ...draft, startsAt: "2026-10-18T23:00", endsAt: "2026-10-19T02:00" },
        authorized,
      )?.endsAt,
    ).toBe("2026-10-18T18:00:00.000Z");
  });
});
