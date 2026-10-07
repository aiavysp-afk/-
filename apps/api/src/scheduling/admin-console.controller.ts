import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { SessionAuthGuard } from "../auth/session-auth.guard.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { AdminConsoleService } from "./admin-console.service.js";

@Controller("admin/organizations/:organizationId")
@UseGuards(SessionAuthGuard)
export class AdminConsoleController {
  constructor(private readonly consoleService: AdminConsoleService) {}

  @Get("technicians")
  async technicians(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
  ) {
    return {
      data: await this.consoleService.technicians(principal, organizationId),
    };
  }

  @Get("service-area")
  serviceArea(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
  ) {
    return {
      data: this.consoleService.serviceArea(principal, organizationId),
    };
  }

  @Get("readiness")
  readiness(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
  ) {
    return {
      data: this.consoleService.readiness(principal, organizationId),
    };
  }
}
