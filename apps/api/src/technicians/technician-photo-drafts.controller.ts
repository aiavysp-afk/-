import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { TechnicianPhotoDraftBindSchema } from "@zydj/contracts";
import { SessionAuthGuard } from "../auth/session-auth.guard.js";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { TechnicianPhotoDraftsService } from "./technician-photo-drafts.service.js";

@Controller(
  "admin/organizations/:organizationId/technicians/:technicianId/profile",
)
@UseGuards(SessionAuthGuard)
export class TechnicianPhotoDraftsController {
  constructor(private readonly drafts: TechnicianPhotoDraftsService) {}
  @Get("binding-targets")
  async targets(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") org: string,
    @Param("technicianId") id: string,
  ) {
    return { data: await this.drafts.targets(principal, org, id) };
  }
  @Post("bind-application")
  async bind(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") org: string,
    @Param("technicianId") id: string,
    @Body() body: unknown,
  ) {
    const input = TechnicianPhotoDraftBindSchema.safeParse(body);
    if (!input.success)
      throw new BadRequestException("关联参数无效，请刷新后重试");
    return { data: await this.drafts.bind(principal, org, id, input.data) };
  }
}
