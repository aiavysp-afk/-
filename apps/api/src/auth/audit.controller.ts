import {
  Controller,
  ForbiddenException,
  Get,
  Query,
  UseGuards,
} from "@nestjs/common";
import { PrismaService } from "../database/prisma.service.js";
import { AccessControlService } from "./access-control.service.js";
import { CurrentPrincipal } from "./current-principal.decorator.js";
import { SessionAuthGuard } from "./session-auth.guard.js";
import type { AuthPrincipal } from "./auth.types.js";

@Controller("admin/audit-logs")
@UseGuards(SessionAuthGuard)
export class AuditController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
  ) {}

  @Get()
  async list(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query("organizationId") requestedOrganizationId?: string,
  ) {
    const allowedOrganizationIds = this.access.allowedOrganizationIds(
      principal,
      "audit.read",
    );
    if (!allowedOrganizationIds.length)
      throw new ForbiddenException("当前身份无权查看审计记录");
    if (
      requestedOrganizationId &&
      !allowedOrganizationIds.includes(requestedOrganizationId)
    ) {
      throw new ForbiddenException("不能查看其他组织的审计记录");
    }
    const organizationIds = requestedOrganizationId
      ? [requestedOrganizationId]
      : allowedOrganizationIds;
    const data = await this.prisma.auditLog.findMany({
      where: { organizationId: { in: organizationIds } },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        organizationId: true,
        action: true,
        resourceType: true,
        resourceId: true,
        createdAt: true,
      },
    });
    return { data, meta: { limit: 50 } };
  }
}
