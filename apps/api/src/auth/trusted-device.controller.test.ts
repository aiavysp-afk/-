import { describe, expect, it, vi } from "vitest";
import {
  TrustedDeviceController,
  STAFF_TRUST_COOKIE,
  readStaffTrustCookie,
  staffTrustCookie,
  clearStaffTrustCookie,
} from "./trusted-device.controller.js";
const actor = {
  userId: "staff-a",
  sessionId: "session-a",
  displayName: "test",
  memberships: [],
};
const token = "a".repeat(43);
function fixture() {
  const device = {
    id: "device-a",
    label: "常用设备",
    expiresAt: "2026-10-20T16:00:00Z",
  };
  const trust = {
    configuration: vi.fn(() => ({ enabled: true, maxDays: 7 })),
    register: vi.fn(async () => ({ device, token })),
    accept: vi.fn(async () => ({ trusted: true })),
    list: vi.fn(async () => [device]),
    revoke: vi.fn(async () => ({ device })),
  };
  const browser = { assertBrowserOrigin: vi.fn() };
  const reply = { header: vi.fn() };
  return {
    controller: new TrustedDeviceController(trust as never, browser as never),
    trust,
    browser,
    reply,
    device,
  };
}
describe("trusted device cookie and HTTP boundary", () => {
  it("sets a host-only Secure HttpOnly Strict cookie with fixed seven-day max-age", () => {
    const value = staffTrustCookie(token, "2026-10-20T16:00:00Z");
    expect(value).toContain(`${STAFF_TRUST_COOKIE}=${token}`);
    for (const setting of [
      "Path=/",
      "Max-Age=604800",
      "HttpOnly",
      "Secure",
      "SameSite=Strict",
      "Expires=Tue, 20 Oct 2026 16:00:00 GMT",
    ])
      expect(value).toContain(setting);
    expect(value.toLowerCase()).not.toContain("domain=");
    expect(clearStaffTrustCookie()).toContain("Max-Age=0");
  });
  it("parses one exact capability but refuses ambiguous, oversized, or encoded cookies", () => {
    expect(
      readStaffTrustCookie(
        `other=1; ${STAFF_TRUST_COOKIE}=${token}; another=2`,
      ),
    ).toBe(token);
    for (const value of [
      undefined,
      `${STAFF_TRUST_COOKIE}=${token}; ${STAFF_TRUST_COOKIE}=${token}`,
      `${STAFF_TRUST_COOKIE}=${token}%00`,
      `${STAFF_TRUST_COOKIE}=short`,
      "x".repeat(16_385),
      `prefix${STAFF_TRUST_COOKIE}=${token}`,
    ])
      expect(readStaffTrustCookie(value)).toBeNull();
  });
  it("exposes only the device summary in JSON, issuing the capability exclusively in Set-Cookie", async () => {
    const f = fixture();
    const result = await f.controller.register(
      actor,
      {},
      "https://admin.example.com",
      "Browser",
      f.reply as never,
    );
    expect(result).toEqual({ data: { device: f.device } });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(f.reply.header.mock.calls[0]![0]).toBe("Set-Cookie");
    expect(f.reply.header.mock.calls[0]![1]).toContain(token);
    expect(f.browser.assertBrowserOrigin).toHaveBeenCalledWith(
      "https://admin.example.com",
    );
  });
  it("rejects untrusted origin and client-supplied expiry/user/role fields before service calls", async () => {
    const f = fixture();
    f.browser.assertBrowserOrigin.mockImplementation(() => {
      throw Error("origin denied");
    });
    await expect(
      f.controller.register(
        actor,
        {},
        "http://evil",
        "Browser",
        f.reply as never,
      ),
    ).rejects.toThrow("origin denied");
    expect(f.trust.register).not.toHaveBeenCalled();
    f.browser.assertBrowserOrigin.mockReset();
    for (const body of [
      { userId: "staff-b" },
      { expiresAt: "2030-01-01" },
      { role: "ADMIN" },
      { label: "x".repeat(81) },
    ])
      await expect(
        f.controller.register(
          actor,
          body,
          "https://admin.example.com",
          "Browser",
          f.reply as never,
        ),
      ).rejects.toThrow("参数无效");
    expect(f.trust.register).not.toHaveBeenCalled();
  });
  it("passes the HttpOnly capability for acceptance without extending the cookie", async () => {
    const f = fixture();
    await f.controller.accept(
      actor,
      {},
      "https://admin.example.com",
      "Browser",
      `${STAFF_TRUST_COOKIE}=${token}`,
      f.reply as never,
    );
    expect(f.trust.accept).toHaveBeenCalledWith(actor, token, "Browser");
    expect(f.reply.header).not.toHaveBeenCalled();
    await expect(
      f.controller.accept(
        actor,
        { token },
        "https://admin.example.com",
        "Browser",
        undefined,
        f.reply as never,
      ),
    ).rejects.toThrow("参数无效");
  });
  it("clears invalid browser cookies but does not expose why trust failed", async () => {
    const f = fixture();
    f.trust.accept.mockResolvedValue({ trusted: false });
    expect(
      await f.controller.accept(
        actor,
        {},
        "https://admin.example.com",
        "Browser",
        `${STAFF_TRUST_COOKIE}=${token}`,
        f.reply as never,
      ),
    ).toEqual({ data: { trusted: false } });
    expect(f.reply.header).toHaveBeenCalledWith(
      "Set-Cookie",
      clearStaffTrustCookie(),
    );
  });
  it("keeps revoke owner scoped and validates both exact origin and a strict ID-only body", async () => {
    const f = fixture();
    expect(
      await f.controller.revoke(
        actor,
        { id: "device-a" },
        "https://admin.example.com",
      ),
    ).toEqual({ data: { device: f.device } });
    expect(f.trust.revoke).toHaveBeenCalledWith(actor, "device-a");
    await expect(
      f.controller.revoke(
        actor,
        { id: "device-a", userId: "staff-b" },
        "https://admin.example.com",
      ),
    ).rejects.toThrow("参数无效");
  });
});
