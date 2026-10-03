import { ForbiddenException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
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
