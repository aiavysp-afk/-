import { describe, expect, it, vi } from "vitest";
import { PhoneWorkbenchSession } from "./phone-workbench-session";

const cap = { enabled: true, workbenchEnabled: true };
const approved = { stage: "APPROVED" };
const tick = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(status: unknown = approved, capabilities: unknown = cap) {
  const request = vi.fn(async (path: string) =>
    path.endsWith("capabilities") ? capabilities : status,
  );
  const expired = vi.fn();
  const session = new PhoneWorkbenchSession(request as never, expired);
  return { request, expired, session };
}
describe("server-proven phone workbench session", () => {
  it("starts with no readiness and consults only capabilities plus authenticated own status", async () => {
    const { session, request } = setup();
    expect(session.isReady("A")).toBe(false);
    session.setToken("A");
    expect(session.isReady("A")).toBe(false);
    await tick();
    expect(session.isReady("A")).toBe(true);
    expect(session.isReady("B")).toBe(false);
    expect(request.mock.calls.map((call) => call[0])).toEqual([
      "/auth/technician-phone/capabilities",
      "/technician/phone-onboarding/status",
    ]);
    expect(request.mock.calls.some((call) => call[0].includes("mfa"))).toBe(
      false,
    );
  });
  it.each([
    "PROFILE_REQUIRED",
    "PHONE_REQUIRED",
    "REJECTED",
    "PENDING_REVIEW",
    undefined,
  ])("rejects %s stage", async (stage) => {
    const { session } = setup({ stage });
    session.setToken("A");
    await tick();
    expect(session.isReady("A")).toBe(false);
  });
  it.each([
    { enabled: false, workbenchEnabled: true },
    { enabled: true, workbenchEnabled: false },
    { enabled: "true", workbenchEnabled: true },
    {},
  ])("requires exact enabled capability booleans %j", async (capabilities) => {
    const { session } = setup(approved, capabilities);
    session.setToken("A");
    await tick();
    expect(session.isReady("A")).toBe(false);
  });
  it("retires captured private requests on switch and ignores old success", async () => {
    const delayed = deferred<unknown>();
    const expired = vi.fn();
    const session = new PhoneWorkbenchSession(
      (async (path: string, token: string) =>
        path.endsWith("capabilities")
          ? cap
          : token === "A"
            ? delayed.promise
            : approved) as never,
      expired,
    );
    session.setToken("A");
    const currentA = session.guard("A");
    session.setToken("B");
    await tick();
    expect(session.isReady("B")).toBe(true);
    delayed.resolve({ stage: "PENDING_REVIEW" });
    await tick();
    expect(currentA()).toBe(false);
    expect(session.isReady("B")).toBe(true);
    expect(expired).not.toHaveBeenCalled();
  });
  it("does not let old unauthorized responses log out a new identity", async () => {
    const delayed = deferred<unknown>();
    const expired = vi.fn();
    const session = new PhoneWorkbenchSession(
      (async (path: string, token: string) =>
        path.endsWith("capabilities")
          ? cap
          : token === "A"
            ? delayed.promise
            : approved) as never,
      expired,
    );
    session.setToken("A");
    session.setToken("B");
    await tick();
    delayed.reject({ status: 401 });
    await tick();
    expect(session.isReady("B")).toBe(true);
    expect(expired).not.toHaveBeenCalled();
  });
  it("clears all guards after denied business requests and never automatically reloads", async () => {
    const { session, expired, request } = setup();
    session.setToken("A");
    await tick();
    const current = session.guard("A", true);
    const calls = request.mock.calls.length;
    await session.recheckAfterForbidden("A");
    expect(current()).toBe(false);
    expect(session.isReady("A")).toBe(false);
    expect(expired).toHaveBeenCalledWith("A");
    expect(request).toHaveBeenCalledTimes(calls);
  });
  it.each([401, 403])("expires denied identity with %s", async (status) => {
    const expired = vi.fn();
    const session = new PhoneWorkbenchSession(
      vi.fn().mockRejectedValue({ status }),
      expired,
    );
    session.setToken("A");
    await tick();
    expect(expired).toHaveBeenCalledWith("A");
    expect(session.isReady("A")).toBe(false);
  });
  it("clears readiness before refresh and exposes transport errors without granting access", async () => {
    const { session, request, expired } = setup();
    session.setToken("A");
    await tick();
    const current = session.guard("A", true);
    request.mockRejectedValueOnce(new Error("network unavailable"));
    const refreshing = session.refresh();
    expect(current()).toBe(false);
    await refreshing;
    expect(session.isReady("A")).toBe(false);
    expect(session.getSnapshot().error).toBe("network unavailable");
    expect(expired).not.toHaveBeenCalled();
  });
  it("cleanup of an older token cannot erase a new token", async () => {
    const { session } = setup();
    session.setToken("A");
    session.setToken("B");
    session.clearIfToken("A");
    await tick();
    expect(session.isReady("B")).toBe(true);
    session.clearIfToken("B");
    expect(session.isReady("B")).toBe(false);
  });
});
