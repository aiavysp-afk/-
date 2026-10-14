import { describe, expect, it, vi } from "vitest";
import {
  customerSmsRouteAllowed,
  requiresAdminStepUp,
  SessionAuthGuard,
} from "./session-auth.guard.js";

describe("browser staff step-up boundary", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "requires fresh TOTP for admin %s",
    (method) => {
      expect(
        requiresAdminStepUp(
          method,
          "/v1/admin/organizations/:id/technicians/:technician/profile",
        ),
      ).toBe(true);
      expect(
        requiresAdminStepUp(method, "/admin/catalog/services/:id/publish"),
      ).toBe(true);
    },
  );
  it.each(["GET", "HEAD", "OPTIONS"])(
    "allows an already verified login to read with %s",
    (method) => {
      expect(
        requiresAdminStepUp(
          method,
          "/v1/admin/organizations/:id/technician-applications",
        ),
      ).toBe(false);
    },
  );
  it("does not confuse customer or login MFA resources with admin mutations", () => {
    expect(requiresAdminStepUp("POST", "/v1/auth/mfa/verify")).toBe(false);
    expect(
      requiresAdminStepUp("POST", "/v1/technician/onboarding/application"),
    ).toBe(false);
    expect(requiresAdminStepUp("POST", "/v1/administer")).toBe(false);
  });
  it("refuses to use trusted-device login assurance as a fresh mutation grant", async () => {
    const principal = {
      authChannel: "ADMIN_BROWSER",
      mfaVerifiedUntil: null,
      staffVerifiedUntil: new Date(Date.now() + 60_000),
      staffVerificationMethod: "TRUSTED_DEVICE",
    };
    const request = {
      headers: { authorization: "Bearer token" },
      method: "POST",
      url: "/v1/%61dmin/catalog/services/a/publish",
      routeOptions: { url: "/v1/admin/catalog/services/:id/publish" },
    };
    const guard = new SessionAuthGuard({
      authenticate: vi.fn().mockResolvedValue(principal),
    } as never);
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as never;
    await expect(guard.canActivate(context)).rejects.toThrow("动态码验证");
    principal.mfaVerifiedUntil = new Date(Date.now() + 60_000) as never;
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});

describe("customer SMS authentication is never staff authentication", () => {
  it.each([
    ["GET", "/v1/admin/organizations/:id/technician-applications"],
    ["POST", "/v1/admin/catalog/services/:id/publish"],
    ["POST", "/v1/auth/browser-login/approve"],
    ["POST", "/v1/auth/browser-login/inspect"],
    ["GET", "/v1/auth/mfa"],
    ["POST", "/v1/auth/mfa/enrollment"],
    ["POST", "/v1/auth/mfa/verify"],
    ["POST", "/v1/auth/mfa/recovery-requests"],
    ["PUT", "/v1/auth/staff-password"],
    ["GET", "/v1/auth/trusted-devices"],
    ["POST", "/v1/technician/onboarding/application/submit"],
    ["GET", "/v1/technician/workbench"],
    ["POST", "/v1/technician-invitations/claim"],
    ["GET", "/v1/future-staff-resource"],
    ["POST", "/v1/auth/wechat-phone"],
    ["POST", "/v1/auth/sms-phone/confirm"],
  ])(
    "rejects %s %s even if the canonical user has ADMIN and fresh MFA",
    async (method, route) => {
      const principal = {
        authProvider: "customer-sms",
        authChannel: "CUSTOMER_SMS",
        memberships: [{ organizationId: "org", role: "ADMIN" }],
        mfaVerifiedUntil: new Date(Date.now() + 60_000),
      };
      const request = {
        headers: { authorization: "Bearer token" },
        method,
        url: "/v1/orders",
        routeOptions: { url: route },
      };
      const guard = new SessionAuthGuard({
        authenticate: vi.fn().mockResolvedValue(principal),
      } as never);
      await expect(
        guard.canActivate({
          switchToHttp: () => ({ getRequest: () => request }),
        } as never),
      ).rejects.toThrow("工作人员功能");
      expect(customerSmsRouteAllowed(method, route)).toBe(false);
    },
  );
  it.each([
    ["GET", "/v1/orders"],
    ["POST", "/v1/orders"],
    ["POST", "/v1/orders/:id/refunds"],
    ["POST", "/v1/orders/:id/safety-incidents"],
    ["GET", "/v1/customer-center/wallet"],
    ["GET", "/v1/customer-center/coupons"],
    ["POST", "/v1/customer-center/newcomer-coupons"],
    ["GET", "/v1/friend-payments/:token"],
    ["POST", "/v1/orders/:id/friend-payment"],
    ["POST", "/v1/booking-holds"],
    ["POST", "/v1/locations/address-verifications"],
    ["GET", "/v1/auth/me"],
    ["POST", "/v1/auth/logout"],
    ["GET", "/v1/payments/notifications"],
    ["GET", "/v1/technicians/:id"],
  ])("keeps customer %s %s accessible", async (method, route) => {
    expect(customerSmsRouteAllowed(method, route)).toBe(true);
    const guard = new SessionAuthGuard({
      authenticate: vi
        .fn()
        .mockResolvedValue({
          authProvider: "customer-sms",
          authChannel: "CUSTOMER_SMS",
        }),
    } as never);
    await expect(
      guard.canActivate({
        switchToHttp: () => ({
          getRequest: () => ({
            headers: { authorization: "Bearer token" },
            method,
            url: route,
            routeOptions: { url: route },
          }),
        }),
      } as never),
    ).resolves.toBe(true);
  });
  it("continues to accept the original WeChat staff route", async () => {
    const guard = new SessionAuthGuard({
      authenticate: vi
        .fn()
        .mockResolvedValue({
          authProvider: "wechat",
          authChannel: "WECHAT_MINIAPP",
        }),
    } as never);
    await expect(
      guard.canActivate({
        switchToHttp: () => ({
          getRequest: () => ({
            headers: { authorization: "Bearer token" },
            method: "POST",
            url: "/v1/auth/browser-login/approve",
          }),
        }),
      } as never),
    ).resolves.toBe(true);
  });
});
