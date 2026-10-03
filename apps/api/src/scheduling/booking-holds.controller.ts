import {
  BadRequestException,
  Body,
  Controller,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { BookingHoldCreateSchema } from "@zydj/contracts";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { SessionAuthGuard } from "../auth/session-auth.guard.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { SchedulingService } from "./scheduling.service.js";

@Controller("booking-holds")
@UseGuards(SessionAuthGuard)
export class BookingHoldsController {
  constructor(private readonly scheduling: SchedulingService) {}

  @Post()
  async create(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body() body: unknown,
  ) {
    const parsed = BookingHoldCreateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("预约占位参数无效");
    return { data: await this.scheduling.createHold(principal, parsed.data) };
  }

  @Post(":id/release")
  async release(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("id") id: string,
  ) {
    return { data: await this.scheduling.releaseHold(principal, id) };
  }
}
