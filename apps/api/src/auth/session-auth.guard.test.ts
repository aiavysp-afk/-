import { describe, expect, it, vi } from "vitest";
import { requiresAdminStepUp, SessionAuthGuard } from "./session-auth.guard.js";

describe("browser staff step-up boundary", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE"])("requires fresh TOTP for admin %s", (method) => {
    expect(requiresAdminStepUp(method, "/v1/admin/organizations/:id/technicians/:technician/profile")).toBe(true);
    expect(requiresAdminStepUp(method, "/admin/catalog/services/:id/publish")).toBe(true);
  });
  it.each(["GET", "HEAD", "OPTIONS"])("allows an already verified login to read with %s", (method) => {
    expect(requiresAdminStepUp(method, "/v1/admin/organizations/:id/technician-applications")).toBe(false);
  });
  it("does not confuse customer or login MFA resources with admin mutations", () => {
    expect(requiresAdminStepUp("POST", "/v1/auth/mfa/verify")).toBe(false);
    expect(requiresAdminStepUp("POST", "/v1/technician/onboarding/application")).toBe(false);
    expect(requiresAdminStepUp("POST", "/v1/administer")).toBe(false);
  });
  it("refuses to use trusted-device login assurance as a fresh mutation grant", async () => {
    const principal = { authChannel: "ADMIN_BROWSER", mfaVerifiedUntil: null, staffVerifiedUntil: new Date(Date.now() + 60_000), staffVerificationMethod: "TRUSTED_DEVICE" };
    const request = { headers: { authorization: "Bearer token" }, method: "POST", url: "/v1/%61dmin/catalog/services/a/publish", routeOptions: { url: "/v1/admin/catalog/services/:id/publish" } };
    const guard = new SessionAuthGuard({ authenticate: vi.fn().mockResolvedValue(principal) } as never);
    const context = { switchToHttp: () => ({ getRequest: () => request }) } as never;
    await expect(guard.canActivate(context)).rejects.toThrow("动态码验证");
    principal.mfaVerifiedUntil = new Date(Date.now() + 60_000) as never;
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});
