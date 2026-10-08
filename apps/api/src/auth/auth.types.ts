import type { UserRole } from "@prisma/client";

export type Permission =
  | "profile.self"
  | "orders.self"
  | "catalog.read"
  | "catalog.write"
  | "schedule.read"
  | "schedule.write"
  | "technicians.manage"
  | "orders.read"
  | "orders.dispatch"
  | "finance.request"
  | "finance.approve"
  | "safety.respond"
  | "audit.read"
  | "iam.manage"
  | "customer-center.manage";

export interface AuthMembership {
  organizationId: string;
  role: UserRole;
}

export interface AuthPrincipal {
  sessionId: string;
  userId: string;
  displayName: string;
  memberships: AuthMembership[];
  mfaVerifiedUntil?: Date | null;
}
