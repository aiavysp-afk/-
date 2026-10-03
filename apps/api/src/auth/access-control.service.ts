import { ForbiddenException, Injectable } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import type { AuthPrincipal, Permission } from "./auth.types.js";

const ROLE_PERMISSIONS: Record<UserRole, readonly (Permission | "*")[]> = {
  CUSTOMER: ["profile.self", "orders.self", "catalog.read"],
  THERAPIST: ["profile.self", "orders.read", "catalog.read"],
  OPERATOR: [
    "profile.self",
    "catalog.read",
    "catalog.write",
    "orders.read",
    "audit.read",
  ],
  DISPATCHER: [
    "profile.self",
    "catalog.read",
    "schedule.read",
    "schedule.write",
    "orders.read",
    "orders.dispatch",
  ],
  FINANCE_REQUESTER: ["profile.self", "orders.read", "finance.request"],
  FINANCE_APPROVER: [
    "profile.self",
    "orders.read",
    "finance.approve",
    "audit.read",
  ],
  SAFETY_DUTY: ["profile.self", "orders.read", "safety.respond"],
  ADMIN: ["*"],
};

@Injectable()
export class AccessControlService {
  hasPermission(
    principal: AuthPrincipal,
    permission: Permission,
    organizationId?: string,
  ) {
    if (permission === "profile.self" || permission === "orders.self")
      return true;
    return principal.memberships.some((membership) => {
      if (organizationId && membership.organizationId !== organizationId)
        return false;
      const permissions = ROLE_PERMISSIONS[membership.role];
      return permissions.includes("*") || permissions.includes(permission);
    });
  }

  assertPermission(
    principal: AuthPrincipal,
    permission: Permission,
    organizationId?: string,
  ) {
    if (!this.hasPermission(principal, permission, organizationId)) {
      throw new ForbiddenException("当前身份无权执行此操作");
    }
  }

  allowedOrganizationIds(principal: AuthPrincipal, permission: Permission) {
    return principal.memberships
      .filter((membership) =>
        this.hasPermission(principal, permission, membership.organizationId),
      )
      .map((membership) => membership.organizationId);
  }
}
