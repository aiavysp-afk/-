import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { TechnicianOrderActionSchema } from "@zydj/contracts";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { SessionAuthGuard } from "../auth/session-auth.guard.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { TechnicianWorkbenchService } from "./technician-workbench.service.js";

@Controller("technician/workbench")
@UseGuards(SessionAuthGuard)
export class TechnicianWorkbenchController {
  constructor(private readonly workbench: TechnicianWorkbenchService) {}

  @Get()
  async get(@CurrentPrincipal() principal: AuthPrincipal) {
    return { data: await this.workbench.get(principal) };
  }

  @Get("earnings")
  async getEarnings(@CurrentPrincipal() principal: AuthPrincipal) {
    return { data: await this.workbench.getEarnings(principal) };
  }

  @Post("orders/:orderId/actions")
  async advance(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("orderId") orderId: string,
    @Body() body: unknown,
  ) {
    const parsed = TechnicianOrderActionSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("履约操作参数无效");
    return {
      data: await this.workbench.advance(principal, orderId, parsed.data),
    };
  }
}
