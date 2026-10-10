import { describe, expect, it, vi } from "vitest";
import {
  MfaSession,
  type MfaRequest,
  type StaffMfaStatus,
} from "./mfa-session";

const now = Date.parse("2026-10-10T01:00:00Z");
const future = new Date(now + 300_000).toISOString();
const status = (patch: Partial<StaffMfaStatus> = {}): StaffMfaStatus => ({
  enabled: true,
  enrollmentPending: false,
  lockedUntil: null,
  verifiedUntil: null,
  required: true,
  staffEligible: true,
  ...patch,
});
const enrollment = {
  secret: "SYNTHETIC_TEST_ONLY",
  issuer: "中原到家",
  accountName: "fixture-user",
  expiresAt: new Date(now + 600_000).toISOString(),
};
const failure = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { status: statusCode });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function fixture(clock = () => now) {
  const request = vi.fn();
  const expired = vi.fn();
  const session = new MfaSession(request as MfaRequest, expired, clock);
  return { request, expired, session };
}

describe("current browser session MFA boundary", () => {
  it("gates a fresh claimed session until its own authoritative status is verified", async () => {
    const { request, session } = fixture();
    request.mockResolvedValue(status());
    session.setToken("browser-A");
    expect(session.isReady("browser-A")).toBe(false);
    await settle();
    expect(request).toHaveBeenCalledWith("/auth/mfa", undefined, "browser-A");
    expect(session.isReady("browser-A")).toBe(false);
    expect(session.guard("browser-A", true)()).toBe(false);
  });

  it("binds explicitly, activates only with this page's secret, then rereads current-session status", async () => {
    const { request, session } = fixture();
    request.mockResolvedValueOnce(status({ enabled: false }));
    session.setToken("browser-A");
    await settle();
    expect(request).toHaveBeenCalledTimes(1);
    request
      .mockResolvedValueOnce(enrollment)
      .mockResolvedValueOnce(
        status({ enabled: false, enrollmentPending: true }),
      );
    await session.enroll();
    expect(request).toHaveBeenNthCalledWith(
      2,
      "/auth/mfa/enrollment",
      {},
      "browser-A",
    );
    expect(session.getSnapshot().enrollment).toEqual(enrollment);
    expect(session.isReady("browser-A")).toBe(false);
    request
      .mockResolvedValueOnce({ verifiedUntil: future })
      .mockResolvedValueOnce(status({ verifiedUntil: future }));
    await session.verify("123456");
    expect(request).toHaveBeenNthCalledWith(
      4,
      "/auth/mfa/activate",
      { code: "123456" },
      "browser-A",
    );
    expect(request).toHaveBeenNthCalledWith(
      5,
      "/auth/mfa",
      undefined,
      "browser-A",
    );
    expect(session.getSnapshot().enrollment).toBeNull();
    expect(session.isReady("browser-A")).toBe(true);
    expect(session.isReady("browser-B")).toBe(false);
  });

  it("cannot claim another session's globally pending enrollment or send malformed codes", async () => {
    const { request, session } = fixture();
    request.mockResolvedValue(
      status({ enabled: false, enrollmentPending: true }),
    );
    session.setToken("browser-A");
    await settle();
    await session.enroll();
    await session.verify("123456");
    expect(request).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().error).toContain("本页没有有效");
    await session.verify("12345");
    expect(request).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().error).toContain("六位数字");
  });

  it("uses verify for bound users and never releases the gate from POST success alone", async () => {
    const { request, session } = fixture();
    request.mockResolvedValueOnce(status());
    session.setToken("browser-A");
    await settle();
    const reread = deferred<StaffMfaStatus>();
    request
      .mockResolvedValueOnce({ verifiedUntil: future })
      .mockReturnValueOnce(reread.promise);
    const verification = session.verify("123456");
    await settle();
    expect(request).toHaveBeenNthCalledWith(
      2,
      "/auth/mfa/verify",
      { code: "123456" },
      "browser-A",
    );
    expect(session.isReady("browser-A")).toBe(false);
    reread.resolve(status());
    await verification;
    expect(session.isReady("browser-A")).toBe(false);
  });

  it("keeps the login after OTP 401, updates lock status, and only expires on status 401", async () => {
    const { request, expired, session } = fixture();
    request.mockResolvedValueOnce(status());
    session.setToken("browser-A");
    await settle();
    request
      .mockRejectedValueOnce(failure(401, "动态码无效或已使用"))
      .mockResolvedValueOnce(status({ lockedUntil: future }));
    await session.verify("123456");
    expect(expired).not.toHaveBeenCalled();
    expect(session.getSnapshot().status?.lockedUntil).toBe(future);
    expect(session.getSnapshot().error).toContain("动态码无效");
    await session.verify("654321");
    expect(request).toHaveBeenCalledTimes(3);
    request.mockRejectedValueOnce(failure(401, "会话已失效"));
    await session.refresh();
    expect(expired).toHaveBeenCalledWith("browser-A");
    expect(session.getSnapshot().status).toBeNull();
  });

  it("does not log out a valid but too-old enrollment session on enrollment 401", async () => {
    const { request, expired, session } = fixture();
    request.mockResolvedValueOnce(status({ enabled: false }));
    session.setToken("browser-A");
    await settle();
    request
      .mockRejectedValueOnce(failure(401, "请重新登录后绑定"))
      .mockResolvedValueOnce(status({ enabled: false }));
    await session.enroll();
    expect(expired).not.toHaveBeenCalled();
    expect(session.getSnapshot().enrollment).toBeNull();
    expect(session.getSnapshot().error).toContain("重新登录");
  });

  it("immediately erases secrets on logout and rejects late verification responses", async () => {
    const { request, expired, session } = fixture();
    request.mockResolvedValueOnce(status({ enabled: false }));
    session.setToken("browser-A");
    await settle();
    request
      .mockResolvedValueOnce(enrollment)
      .mockResolvedValueOnce(
        status({ enabled: false, enrollmentPending: true }),
      );
    await session.enroll();
    const activate = deferred<{ verifiedUntil: string }>();
    request.mockReturnValueOnce(activate.promise);
    const verification = session.verify("123456");
    const privateRequest = session.guard("browser-A", true);
    session.setToken("");
    expect(session.getSnapshot().enrollment).toBeNull();
    expect(privateRequest()).toBe(false);
    activate.resolve({ verifiedUntil: future });
    await verification;
    expect(request).toHaveBeenCalledTimes(4); // No status fetch using logged-out token.
    expect(session.getSnapshot().status).toBeNull();
    expect(expired).not.toHaveBeenCalled();
  });

  it("clears an expired binding secret and cannot activate it or revive it with a late response", async () => {
    let clock = now;
    const { request, session } = fixture(() => clock);
    request.mockResolvedValueOnce(status({ enabled: false }));
    session.setToken("browser-A");
    await settle();
    request
      .mockResolvedValueOnce(enrollment)
      .mockResolvedValueOnce(
        status({ enabled: false, enrollmentPending: true }),
      );
    await session.enroll();
    session.expireEnrollment("browser-A");
    expect(session.getSnapshot().enrollment).toEqual(enrollment);
    clock += 600_000;
    session.expireEnrollment("browser-A");
    expect(session.getSnapshot().enrollment).toBeNull();
    await session.verify("123456");
    expect(request).toHaveBeenCalledTimes(3);
    expect(session.isReady("browser-A")).toBe(false);
  });

  it("ignores an old status 401 and enrollment secret after switching identities", async () => {
    const { request, expired, session } = fixture();
    const oldStatus = deferred<StaffMfaStatus>();
    request
      .mockReturnValueOnce(oldStatus.promise)
      .mockResolvedValueOnce(status({ enabled: false }));
    session.setToken("browser-A");
    session.setToken("browser-B");
    await settle();
    oldStatus.reject(failure(401, "旧会话过期"));
    await settle();
    expect(expired).not.toHaveBeenCalled();
    const oldEnrollment = deferred<typeof enrollment>();
    request.mockReturnValueOnce(oldEnrollment.promise);
    const binding = session.enroll();
    request.mockResolvedValueOnce(status({ verifiedUntil: future }));
    session.setToken("browser-C");
    await settle();
    session.clearIfToken("browser-B"); // A previous React effect's cleanup.
    oldEnrollment.resolve(enrollment);
    await binding;
    expect(session.getSnapshot().enrollment).toBeNull();
    expect(session.isReady("browser-C")).toBe(true);
  });

  it("invalidates captured private requests at expiry, even before the UI timer runs", async () => {
    let clock = now;
    const { request, session } = fixture(() => clock);
    request.mockResolvedValue(status({ verifiedUntil: future }));
    session.setToken("browser-A");
    await settle();
    const current = session.guard("browser-A", true);
    expect(current()).toBe(true);
    clock += 300_000;
    expect(current()).toBe(false);
    session.expire("browser-A");
    expect(session.getSnapshot().status?.verifiedUntil).toBeNull();
    expect(session.getSnapshot().error).toContain("已到期");
    request.mockResolvedValue(
      status({ verifiedUntil: new Date(clock + 300_000).toISOString() }),
    );
    await session.refresh();
    expect(session.isReady("browser-A")).toBe(true);
    expect(current()).toBe(false); // A refresh cannot revive an old request.
  });

  it("never revives an expired private request when re-verification beats a delayed UI timer", async () => {
    let clock = now;
    const { request, session } = fixture(() => clock);
    request.mockResolvedValueOnce(status({ verifiedUntil: future }));
    session.setToken("browser-A");
    await settle();
    const oldPrivateRequest = session.guard("browser-A", true);
    clock += 300_000;
    expect(oldPrivateRequest()).toBe(false);
    const renewed = new Date(clock + 300_000).toISOString();
    request
      .mockResolvedValueOnce({ verifiedUntil: renewed })
      .mockResolvedValueOnce(status({ verifiedUntil: renewed }));
    await session.verify("123456");
    expect(session.isReady("browser-A")).toBe(true);
    expect(oldPrivateRequest()).toBe(false);
  });

  it("fails closed on status/network errors and excludes ineligible identities", async () => {
    const { request, session } = fixture();
    request.mockRejectedValueOnce(new Error("网络不可用"));
    session.setToken("browser-A");
    await settle();
    expect(session.isReady("browser-A")).toBe(false);
    expect(session.getSnapshot().error).toBe("网络不可用");
    request.mockResolvedValue(
      status({ staffEligible: false, verifiedUntil: future }),
    );
    await session.refresh();
    expect(session.isReady("browser-A")).toBe(false);
    await session.verify("123456");
    expect(request).toHaveBeenCalledTimes(2);
    request.mockResolvedValue({ staffEligible: true });
    await session.refresh();
    expect(session.isReady("browser-A")).toBe(false);
  });

  it("does not let an old private response populate a different account after switching", async () => {
    const { request, session } = fixture();
    request.mockResolvedValue(status({ verifiedUntil: future }));
    session.setToken("browser-A");
    await settle();
    const current = session.guard("browser-A", true);
    const privateResponse = deferred<string>();
    let displayed = "";
    const load = privateResponse.promise.then((data) => {
      if (current()) displayed = data;
    });
    session.setToken("browser-B");
    await settle();
    expect(session.isReady("browser-B")).toBe(true);
    privateResponse.resolve("account-A private orders");
    await load;
    expect(displayed).toBe("");
  });

  it("preserves optional MFA only when the server explicitly disables the development requirement", async () => {
    const { request, session } = fixture();
    request.mockResolvedValue(status({ required: false, enabled: false }));
    session.setToken("development-session");
    await settle();
    expect(session.isReady("development-session")).toBe(true);
  });

  it("rechecks a forbidden response without retry loops and returns expired MFA to the gate", async () => {
    const { request, session } = fixture();
    request.mockResolvedValueOnce(status({ verifiedUntil: future }));
    session.setToken("browser-A");
    await settle();
    const oldRequest = session.guard("browser-A", true);
    request.mockResolvedValueOnce(status({ verifiedUntil: future }));
    await session.recheckAfterForbidden("browser-A");
    expect(session.isReady("browser-A")).toBe(true);
    expect(oldRequest()).toBe(true);
    request.mockResolvedValueOnce(status());
    await session.recheckAfterForbidden("browser-A");
    expect(session.isReady("browser-A")).toBe(false);
    expect(oldRequest()).toBe(false);
    expect(request).toHaveBeenCalledTimes(3);
  });
});
