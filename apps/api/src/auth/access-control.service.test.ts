import { ForbiddenException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { ConfigService } from "@nestjs/config";
import { describe, expect, it } from "vitest";
import { AccessControlService } from "./access-control.service.js";
import type { AuthPrincipal } from "./auth.types.js";

const principal = (
  role: UserRole,
  organizationId = "org-a",
): AuthPrincipal => ({
  sessionId: "session-1",
  userId: "user-1",
  displayName: "测试用户",
  memberships: [{ organizationId, role }],
});

describe("AccessControlService", () => {
  const access = new AccessControlService();

  it("requires recent MFA in production even if the development flag is false", () => {
    const required = new AccessControlService(
      new ConfigService({
        NODE_ENV: "production",
        STAFF_MFA_REQUIRED: "false",
      }),
    );
    const actor = principal(UserRole.ADMIN);
    expect(required.hasPermission(actor, "finance.approve", "org-a")).toBe(
      false,
    );
    actor.mfaVerifiedUntil = new Date(Date.now() + 60_000);
    expect(required.hasPermission(actor, "finance.approve", "org-a")).toBe(
      true,
    );
    expect(required.hasPermission(actor, "finance.approve", "org-b")).toBe(
      false,
    );
    actor.mfaVerifiedUntil = new Date(Date.now() - 1);
    expect(required.hasPermission(actor, "finance.approve", "org-a")).toBe(
      false,
    );
    expect(required.hasPermission(actor, "orders.self")).toBe(true);
  });

  it("supports a private opt-in without weakening role separation", () => {
    const required = new AccessControlService(
      new ConfigService({ NODE_ENV: "test", STAFF_MFA_REQUIRED: "true" }),
    );
    const actor = principal(UserRole.FINANCE_REQUESTER);
    expect(required.hasPermission(actor, "finance.request", "org-a")).toBe(
      false,
    );
    actor.mfaVerifiedUntil = new Date(Date.now() + 60_000);
    expect(required.hasPermission(actor, "finance.request", "org-a")).toBe(
      true,
    );
    expect(required.hasPermission(actor, "finance.approve", "org-a")).toBe(
      false,
    );
  });

  it("allows an operator to manage the catalog only inside the assigned organization", () => {
    expect(
      access.hasPermission(
        principal(UserRole.OPERATOR),
        "catalog.write",
        "org-a",
      ),
    ).toBe(true);
    expect(
      access.hasPermission(
        principal(UserRole.OPERATOR),
        "catalog.write",
        "org-b",
      ),
    ).toBe(false);
  });

  it("derives audit scope from memberships instead of a client supplied organization", () => {
    const operator = principal(UserRole.OPERATOR, "org-a");
    operator.memberships.push({
      organizationId: "org-b",
      role: UserRole.DISPATCHER,
    });
    expect(access.allowedOrganizationIds(operator, "audit.read")).toEqual([
      "org-a",
    ]);
  });

  it("enforces finance requester and approver separation", () => {
    expect(
      access.hasPermission(
        principal(UserRole.FINANCE_REQUESTER),
        "finance.approve",
        "org-a",
      ),
    ).toBe(false);
    expect(
      access.hasPermission(
        principal(UserRole.FINANCE_APPROVER),
        "finance.request",
        "org-a",
      ),
    ).toBe(false);
  });

  it("rejects a customer attempting staff operations", () => {
    const customer: AuthPrincipal = {
      sessionId: "session-customer",
      userId: "customer-1",
      displayName: "微信用户",
      memberships: [],
    };
    expect(() =>
      access.assertPermission(customer, "orders.dispatch", "org-a"),
    ).toThrow(ForbiddenException);
  });

  it("allows dispatchers, but not operators, to manage organization schedules", () => {
    expect(
      access.hasPermission(
        principal(UserRole.DISPATCHER),
        "schedule.write",
        "org-a",
      ),
    ).toBe(true);
    expect(
      access.hasPermission(
        principal(UserRole.OPERATOR),
        "schedule.write",
        "org-a",
      ),
    ).toBe(false);
  });
});
