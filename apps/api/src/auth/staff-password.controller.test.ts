import { describe, expect, it, vi } from "vitest";
import type { FastifyRequest } from "fastify";
import { StaffPasswordController } from "./staff-password.controller.js";
import type { AuthPrincipal } from "./auth.types.js";

const ORIGIN = "https://admin.example.com";
const REQUEST = {
  raw: { socket: { remoteAddress: "socket-peer" } },
  headers: { "x-forwarded-for": "caller-controlled-address" },
} as unknown as FastifyRequest;
const LOGIN = { account: "13800001234", password: "correct-password" };
const CONFIRM = {
  challengeId: "b455d02e-2657-4269-9155-4e2b486c2c52",
  challengeSecret: "A".repeat(43),
  code: "123456",
};
const principal: AuthPrincipal = {
  sessionId: "session-1",
  userId: "user-1",
  displayName: "staff",
  memberships: [{ organizationId: "org-1", role: "OPERATOR" }],
};
function fixture() {
  const service = {
    configuration: vi.fn(() => ({
      enabled: true,
      smsEnabled: true,
      setupEnabled: false,
    })),
    assertBrowserOrigin: vi.fn((origin?: string) => {
      if (origin !== ORIGIN) throw new Error("origin denied");
    }),
    status: vi.fn(async () => ({
      configured: true,
      maskedAccount: "138****1234",
      loginAlias: null,
    })),
    setPassword: vi.fn(async () => ({ configured: true })),
    login: vi.fn(async () => ({ challengeId: CONFIRM.challengeId })),
    confirm: vi.fn(async () => ({ accessToken: "session-token" })),
  };
  return { service, controller: new StaffPasswordController(service as never) };
}

describe("staff password controller request boundaries", () => {
  it("returns only readiness booleans in public configuration", () => {
    const f = fixture();
    expect(f.controller.configuration()).toEqual({
      data: { enabled: true, smsEnabled: true, setupEnabled: false },
    });
  });
  it("passes only the authenticated principal to self credential management", async () => {
    const f = fixture();
    await f.controller.status(principal);
    await f.controller.setPassword(
      principal,
      { password: LOGIN.password },
      ORIGIN,
    );
    expect(f.service.status).toHaveBeenCalledWith(principal);
    expect(f.service.setPassword).toHaveBeenCalledWith(
      principal,
      LOGIN.password,
    );
  });
  it("requires exact origin for setting a password, login and confirmation", async () => {
    const f = fixture();
    await expect(
      f.controller.setPassword(
        principal,
        { password: LOGIN.password },
        undefined,
      ),
    ).rejects.toThrow("origin denied");
    await expect(
      f.controller.login(LOGIN, "https://evil.example.com", REQUEST),
    ).rejects.toThrow("origin denied");
    await expect(
      f.controller.confirm(CONFIRM, undefined, REQUEST),
    ).rejects.toThrow("origin denied");
    expect(f.service.setPassword).not.toHaveBeenCalled();
    expect(f.service.login).not.toHaveBeenCalled();
    expect(f.service.confirm).not.toHaveBeenCalled();
  });
  it("uses socket peer rather than caller-controlled forwarded IP", async () => {
    const f = fixture();
    await f.controller.login(LOGIN, ORIGIN, REQUEST);
    await f.controller.confirm(CONFIRM, ORIGIN, REQUEST);
    expect(f.service.login).toHaveBeenCalledWith(LOGIN, "socket-peer");
    expect(f.service.confirm).toHaveBeenCalledWith(CONFIRM, "socket-peer");
  });
  it("accepts an existing login alias or phone account and passes canonical input only", async () => {
    const f = fixture();
    await f.controller.login({ ...LOGIN, account: " AdMiN " }, ORIGIN, REQUEST);
    expect(f.service.login).toHaveBeenLastCalledWith(
      { ...LOGIN, account: "admin" },
      "socket-peer",
    );
    await f.controller.login(
      { ...LOGIN, account: " 13800001234 " },
      ORIGIN,
      REQUEST,
    );
    expect(f.service.login).toHaveBeenLastCalledWith(LOGIN, "socket-peer");
  });
  it("allows self password setup to include a normalized alias without accepting another identity", async () => {
    const f = fixture();
    expect(
      await f.controller.setPassword(
        principal,
        { password: LOGIN.password, loginAlias: " AdMiN " },
        ORIGIN,
      ),
    ).toEqual({ data: { configured: true } });
    expect(f.service.setPassword).toHaveBeenCalledWith(
      principal,
      LOGIN.password,
      undefined,
      "admin",
    );
    expect(await f.controller.status(principal)).toEqual({
      data: {
        configured: true,
        maskedAccount: "138****1234",
        loginAlias: null,
      },
    });
  });
  it.each([
    "",
    " ",
    null,
    "abc",
    "a".repeat(33),
    "1admin",
    "13800001234",
    "管理员",
    "admin@example.com",
  ])(
    "rejects an invalid alias rather than silently clearing or binding it",
    async (loginAlias) => {
      const f = fixture();
      await expect(
        f.controller.setPassword(
          principal,
          { password: LOGIN.password, loginAlias },
          ORIGIN,
        ),
      ).rejects.toMatchObject({ status: 400 });
      expect(f.service.setPassword).not.toHaveBeenCalled();
    },
  );
  it.each([
    { ...LOGIN, role: "ADMIN" },
    { ...LOGIN, userId: "someone-else" },
    { ...LOGIN, phone: "13900001234" },
    { ...LOGIN, loginAlias: "admin" },
    { ...LOGIN, account: "bad!" },
    { ...LOGIN, password: "short" },
    { ...LOGIN, password: "a".repeat(129) },
  ])("rejects invalid or privilege-bearing login fields", async (input) => {
    const f = fixture();
    await expect(
      f.controller.login(input, ORIGIN, REQUEST),
    ).rejects.toMatchObject({ status: 400 });
    expect(f.service.login).not.toHaveBeenCalled();
  });
  it.each([
    { ...CONFIRM, userId: "other-user" },
    { ...CONFIRM, challengeId: "bad-id" },
    { ...CONFIRM, challengeSecret: "too-short" },
    { ...CONFIRM, code: "abc123" },
    { ...CONFIRM, code: "12345" },
  ])(
    "rejects invalid or cross-account SMS confirmation fields",
    async (input) => {
      const f = fixture();
      await expect(
        f.controller.confirm(input, ORIGIN, REQUEST),
      ).rejects.toMatchObject({ status: 400 });
      expect(f.service.confirm).not.toHaveBeenCalled();
    },
  );
  it("cannot set password or bind a phone for someone else", async () => {
    const f = fixture();
    await expect(
      f.controller.setPassword(
        principal,
        { password: LOGIN.password, userId: "other" },
        ORIGIN,
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      f.controller.setPassword(
        principal,
        { password: LOGIN.password, account: LOGIN.account },
        ORIGIN,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(f.service.setPassword).not.toHaveBeenCalled();
  });
});
