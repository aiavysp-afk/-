import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import { AvailabilityQuerySchema } from "@zydj/contracts";
import { SchedulingService } from "./scheduling.service.js";

@Controller("availability")
export class AvailabilityController {
  constructor(private readonly scheduling: SchedulingService) {}

  @Get("slots")
  async list(@Query() query: unknown) {
    const parsed = AvailabilityQuerySchema.safeParse(query);
    if (!parsed.success)
      throw new BadRequestException("可预约时段查询参数无效");
    const data = await this.scheduling.listAvailability(parsed.data);
    return {
      data,
      meta: {
        total: data.length,
        date: parsed.data.date,
        timeZone: parsed.data.timeZone,
        slotIntervalMinutes: 30,
      },
    };
  }
}
