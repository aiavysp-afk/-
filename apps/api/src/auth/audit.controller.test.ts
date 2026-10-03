import { ForbiddenException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../database/prisma.service.js";
import { AccessControlService } from "./access-control.service.js";
import { AuditController } from "./audit.controller.js";
import type { AuthPrincipal } from "./auth.types.js";

const operator: AuthPrincipal = {
  sessionId: "session-1",
  userId: "operator-1",
  displayName: "运营人员",
  memberships: [{ organizationId: "org-a", role: UserRole.OPERATOR }],
};

describe("AuditController organization scope", () => {
  it("rejects a client supplied organization outside the authenticated membership", async () => {
    const findMany = vi.fn();
    const controller = new AuditController(
      { auditLog: { findMany } } as unknown as PrismaService,
      new AccessControlService(),
    );

    await expect(controller.list(operator, "org-b")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(findMany).not.toHaveBeenCalled();
  });

  it("queries only the organization derived from the authenticated membership", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const controller = new AuditController(
      { auditLog: { findMany } } as unknown as PrismaService,
      new AccessControlService(),
    );

    await controller.list(operator);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: { in: ["org-a"] } } }),
    );
  });
});
