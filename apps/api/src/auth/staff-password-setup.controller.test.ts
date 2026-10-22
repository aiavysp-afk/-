import { describe, expect, it, vi } from "vitest";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";
import { StaffPasswordSetupController } from "./staff-password-setup.controller.js";

const ORIGIN = "https://admin.example.com";
const REQUEST = {
  raw: { socket: { remoteAddress: "actual-peer" } },
  headers: { "x-forwarded-for": "spoofed-peer" },
} as unknown as FastifyRequest;
const INPUT = {
  challengeId: "b455d02e-2657-4269-9155-4e2b486c2c52",
  challengeSecret: "A".repeat(43),
  code: "123456",
  loginAlias: "admin",
  password: "a-long-self-set-password",
};
function fixture() {
  const service = {
    assertBrowserOrigin: vi.fn((origin?: string) => {
      if (origin !== ORIGIN) throw new Error("origin denied");
    }),
    request: vi.fn(async () => ({ challengeId: INPUT.challengeId })),
    confirm: vi.fn(async () => ({ accessToken: "session-token" })),
  };
  return {
    service,
    controller: new StaffPasswordSetupController(service as never),
  };
}
describe("staff password first-time setup controller", () => {
  it("keeps both POST endpoints 200/no-store and sends only strict input and socket IP to service", async () => {
    const f = fixture();
    expect(
      await f.controller.request({ phone: "13800001234" }, ORIGIN, REQUEST),
    ).toEqual({ data: { challengeId: INPUT.challengeId } });
    expect(f.service.request).toHaveBeenCalledWith(
      { phone: "13800001234" },
      "actual-peer",
    );
    expect(
      await f.controller.confirm(
        { ...INPUT, loginAlias: " AdMiN " },
        ORIGIN,
        REQUEST,
      ),
    ).toEqual({ data: { accessToken: "session-token" } });
    expect(f.service.confirm).toHaveBeenCalledWith(INPUT, "actual-peer");
    const reflector = new Reflector();
    for (const method of [f.controller.request, f.controller.confirm]) {
      expect(reflector.get("__httpCode__", method)).toBe(200);
      expect(reflector.get("__headers__", method)).toContainEqual({
        name: "Cache-Control",
        value: "no-store",
      });
    }
  });
  it.each([undefined, "https://evil.example.com"])(
    "denies origin %s before any service mutation",
    async (origin) => {
      const f = fixture();
      await expect(
        f.controller.request({ phone: "13800001234" }, origin, REQUEST),
      ).rejects.toThrow("origin denied");
      await expect(
        f.controller.confirm(INPUT, origin, REQUEST),
      ).rejects.toThrow("origin denied");
      expect(f.service.request).not.toHaveBeenCalled();
      expect(f.service.confirm).not.toHaveBeenCalled();
    },
  );
  it("accepts omitted alias for bound-phone login without inventing an alias", async () => {
    const f = fixture();
    const { loginAlias: _ignored, ...phoneOnly } = INPUT;
    await f.controller.confirm(phoneOnly, ORIGIN, REQUEST);
    expect(f.service.confirm).toHaveBeenCalledExactlyOnceWith(phoneOnly, "actual-peer");
  });
  it.each([
    { phone: "123" },
    { phone: "13800001234", userId: "other" },
    { phone: "13800001234", role: "ADMIN" },
    { phone: "13800001234", reset: true },
  ])("rejects malformed or privilege-bearing request fields", async (body) => {
    const f = fixture();
    await expect(
      f.controller.request(body, ORIGIN, REQUEST),
    ).rejects.toMatchObject({ status: 400 });
    expect(f.service.request).not.toHaveBeenCalled();
  });
  it.each([
    { challengeId: "invalid" },
    { challengeSecret: "short" },
    { code: "12345" },
    { code: 123456 },
    { loginAlias: "" },
    { loginAlias: " " },
    { loginAlias: null },
    { loginAlias: 123456 },
    { loginAlias: "13800001234" },
    { loginAlias: "管理员" },
    { loginAlias: "123admin" },
    { loginAlias: "a".repeat(33) },
    { password: "123456" },
    { password: "a".repeat(129) },
    { password: "null-byte\0-password" },
    { phone: "13900001234" },
    { userId: "other" },
    { role: "ADMIN" },
    { mfaVerifiedUntil: "2099-01-01" },
  ])(
    "rejects malformed and cross-identity confirmation fields",
    async (change) => {
      const f = fixture();
      await expect(
        f.controller.confirm({ ...INPUT, ...change }, ORIGIN, REQUEST),
      ).rejects.toMatchObject({ status: 400 });
      expect(f.service.confirm).not.toHaveBeenCalled();
    },
  );
});
