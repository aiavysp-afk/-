import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ShiftCreateSchema } from "@zydj/contracts";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { SessionAuthGuard } from "../auth/session-auth.guard.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { SchedulingService } from "./scheduling.service.js";

@Controller("admin/scheduling/shifts")
@UseGuards(SessionAuthGuard)
export class AdminSchedulingController {
  constructor(private readonly scheduling: SchedulingService) {}

  @Get()
  async list(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query("organizationId") organizationId?: string,
    @Query("date") date?: string,
  ) {
    if (!organizationId || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) {
      throw new BadRequestException("排班查询参数无效");
    }
    const data = await this.scheduling.listShifts(
      principal,
      organizationId,
      date!,
    );
    return {
      data,
      meta: { total: data.length, date, timeZone: "Asia/Shanghai" },
    };
  }

  @Post()
  async create(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body() body: unknown,
  ) {
    const parsed = ShiftCreateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("排班参数无效");
    return { data: await this.scheduling.createShift(principal, parsed.data) };
  }
}
