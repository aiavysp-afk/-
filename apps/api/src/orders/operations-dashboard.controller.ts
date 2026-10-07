import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { SessionAuthGuard } from "../auth/session-auth.guard.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { OperationsDashboardService } from "./operations-dashboard.service.js";

@Controller("admin/organizations/:organizationId/dashboard")
@UseGuards(SessionAuthGuard)
export class OperationsDashboardController {
  constructor(private readonly dashboard: OperationsDashboardService) {}

  @Get()
  async get(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
  ) {
    return { data: await this.dashboard.get(principal, organizationId) };
  }
}
