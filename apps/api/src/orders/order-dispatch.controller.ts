import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { DispatchAssignmentSchema } from "@zydj/contracts";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { SessionAuthGuard } from "../auth/session-auth.guard.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { OrderDispatchService } from "./order-dispatch.service.js";

@Controller("admin/organizations/:organizationId/dispatch")
@UseGuards(SessionAuthGuard)
export class OrderDispatchController {
  constructor(private readonly dispatch: OrderDispatchService) {}

  @Get()
  async getBoard(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
  ) {
    return { data: await this.dispatch.getBoard(principal, organizationId) };
  }

  @Post("orders/:orderId/assign")
  async assign(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
    @Param("orderId") orderId: string,
    @Body() body: unknown,
  ) {
    const parsed = DispatchAssignmentSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("技师指派参数无效");
    return {
      data: await this.dispatch.assign(
        principal,
        organizationId,
        orderId,
        parsed.data,
      ),
    };
  }
}
