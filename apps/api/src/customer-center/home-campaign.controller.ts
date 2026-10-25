import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { HomeCampaignSaveSchema } from "@zydj/contracts";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { SessionAuthGuard } from "../auth/session-auth.guard.js";
import { HomeCampaignService } from "./home-campaign.service.js";

@Controller("campaigns/home")
export class HomeCampaignController {
  constructor(private readonly campaigns: HomeCampaignService) {}
  @Get()
  async current(@Res({ passthrough: true }) response: FastifyReply) {
    response.header("Cache-Control", "no-store");
    return { data: await this.campaigns.current() };
  }
  @Get("image/:organizationId/:version")
  async image(
    @Param("organizationId") org: string,
    @Param("version") version: string,
    @Res() response: FastifyReply,
  ) {
    if (!/^\d{1,9}$/.test(version)) throw new BadRequestException();
    const image = await this.campaigns.image(org, Number(version));
    return response
      .header("Content-Type", "image/jpeg")
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .send(image);
  }
}

@Controller("admin/organizations/:organizationId/customer-center/home-campaign")
@UseGuards(SessionAuthGuard)
export class AdminHomeCampaignController {
  constructor(private readonly campaigns: HomeCampaignService) {}
  @Get()
  async get(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") org: string,
  ) {
    return { data: await this.campaigns.admin(principal, org) };
  }
  @Patch()
  async save(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") org: string,
    @Body() body: unknown,
  ) {
    const parsed = HomeCampaignSaveSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException(
        parsed.error.issues[0]?.message || "活动参数无效",
      );
    return { data: await this.campaigns.save(principal, org, parsed.data) };
  }
}
