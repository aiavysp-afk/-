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
import { TechnicianShowcaseSaveSchema } from "@zydj/contracts";
import { SessionAuthGuard } from "../auth/session-auth.guard.js";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { TechnicianShowcaseService } from "./technician-showcase.service.js";

@Controller("technician-showcase")
export class TechnicianShowcaseController {
  constructor(private readonly showcase: TechnicianShowcaseService) {}
  @Get()
  async list(@Res({ passthrough: true }) response: FastifyReply) {
    response.header("Cache-Control", "no-store");
    return { data: await this.showcase.list() };
  }
  @Get("photos/:photoId")
  async image(
    @Param("photoId") photoId: string,
    @Res() response: FastifyReply,
  ) {
    // Resolve authorization/availability before setting a binary content type,
    // so missing/withdrawn images retain the normal JSON 404 response.
    const bytes = await this.showcase.image(photoId);
    return response
      .type("image/jpeg")
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("Cross-Origin-Resource-Policy", "cross-origin")
      .header("Content-Security-Policy", "default-src 'none'")
      .send(bytes);
  }
}
@Controller(
  "admin/organizations/:organizationId/technicians/:technicianId/profile/showcase",
)
@UseGuards(SessionAuthGuard)
export class AdminTechnicianShowcaseController {
  constructor(private readonly showcase: TechnicianShowcaseService) {}
  @Patch()
  async save(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
    @Param("technicianId") technicianId: string,
    @Body() body: unknown,
  ) {
    const input = TechnicianShowcaseSaveSchema.safeParse(body);
    if (!input.success) throw new BadRequestException("照片展示参数无效");
    return {
      data: await this.showcase.save(
        principal,
        organizationId,
        technicianId,
        input.data,
      ),
    };
  }
}
