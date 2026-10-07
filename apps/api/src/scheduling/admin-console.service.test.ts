import { OrderStatus, ShiftStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { AdminConsoleService } from "./admin-console.service.js";

const principal: AuthPrincipal = {
  sessionId: "session-admin",
  userId: "admin-1",
  displayName: "管理员",
  memberships: [{ organizationId: "org-1", role: "ADMIN" }],
};

const environment = {
  NODE_ENV: "development",
  SERVICE_CITY: "郑州市",
  SERVICE_AREA_ADCODE_ALLOWLIST:
    "410102,410103,410104,410105,410106,410108,410122,410171,410172,410173,410181,410182,410183,410184,410185",
  MAP_PROVIDER: "mock",
  MAP_GEOCODING_ENABLED: "false",
  AUTH_PROVIDER: "mock",
  STAFF_MFA_REQUIRED: "false",
  STAFF_BROWSER_LOGIN_ENABLED: "false",
  PAYMENT_PROVIDER: "mock",
  WECHAT_PAY_PREPAY_ENABLED: "false",
  WECHAT_PAY_RECOVERY_ENABLED: "false",
  WECHAT_PAY_REFUND_ENABLED: "false",
  SMS_PROVIDER: "mock",
  SMS_SEND_ENABLED: "false",
  SAFETY_NOTIFICATION_DISPATCH_ENABLED: "false",
  SAFETY_NOTIFICATION_RECEIPT_QUERY_ENABLED: "false",
  SAFETY_DUTY_CONFIRMED: "false",
  CUSTOMER_SERVICE_PROVIDER: "none",
  WECOM_CUSTOMER_SERVICE_CONFIRMED: "false",
} as const;

describe("AdminConsoleService", () => {
  it("lists organization-scoped technicians without customer private data", async () => {
    const prisma = {
      staffMembership: {
        findMany: vi.fn().mockResolvedValue([
          {
            user: {
              id: "therapist-1",
              displayName: "安然",
              status: "ACTIVE",
              therapistShifts: [
                {
                  id: "shift-1",
                  startsAt: new Date("2026-10-07T00:00:00.000Z"),
                  endsAt: new Date("2026-10-07T10:00:00.000Z"),
                  status: ShiftStatus.ACTIVE,
                },
              ],
              therapistOrders: [
                { status: OrderStatus.IN_SERVICE },
                { status: OrderStatus.COMPLETED },
              ],
            },
          },
        ]),
      },
    };
    const access = { assertPermission: vi.fn() };
    const config = {
      get: vi.fn((key: keyof typeof environment) => environment[key]),
    };
    const service = new AdminConsoleService(
      prisma as never,
      access as never,
      config as never,
    );

    const result = await service.technicians(
      principal,
      "org-1",
      new Date("2026-10-07T08:00:00.000Z"),
    );

    expect(access.assertPermission).toHaveBeenCalledWith(
      principal,
      "schedule.read",
      "org-1",
    );
    expect(result.technicians[0]).toMatchObject({
      id: "therapist-1",
      displayName: "安然",
      availability: "ON_SHIFT",
      metrics: { activeOrders: 1, completedToday: 1 },
    });
    expect(result.technicians[0]).not.toHaveProperty("phone");
    expect(result.technicians[0]).not.toHaveProperty("customerOrders");
  });

  it("reports Zhengzhou-wide target coverage without enabling the map gate", () => {
    const access = { assertPermission: vi.fn() };
    const config = {
      get: vi.fn((key: keyof typeof environment) => environment[key]),
    };
    const service = new AdminConsoleService(
      {} as never,
      access as never,
      config as never,
    );

    const result = service.serviceArea(principal, "org-1");

    expect(result).toMatchObject({
      coveragePolicy: "ZHENGZHOU_FULL",
      fullyConfigured: true,
      mapProvider: "mock",
      verificationEnabled: false,
    });
    expect(result.targetAdcodes).toHaveLength(15);
    expect(access.assertPermission).toHaveBeenCalledWith(
      principal,
      "orders.read",
      "org-1",
    );
  });

  it("returns only non-secret readiness switches", () => {
    const access = { assertPermission: vi.fn() };
    const config = {
      get: vi.fn((key: keyof typeof environment) => environment[key]),
    };
    const service = new AdminConsoleService(
      {} as never,
      access as never,
      config as never,
    );

    const result = service.readiness(principal, "org-1");

    expect(result.payment).toEqual({
      provider: "mock",
      prepayEnabled: false,
      recoveryEnabled: false,
      refundEnabled: false,
    });
    expect(JSON.stringify(result)).not.toMatch(/KEY|SECRET|CERT|PASSWORD/);
  });
});
