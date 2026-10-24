import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Post,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { SessionAuthGuard } from "../auth/session-auth.guard.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { TechnicianNotificationsService } from "./technician-notifications.service.js";
const Subscription = z
  .object({
    requestId: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/),
    templateId: z.string().min(20).max(128),
    accepted: z.literal(true),
  })
  .strict();
@Controller("technician/workbench/notifications")
@UseGuards(SessionAuthGuard)
export class TechnicianNotificationsController {
  constructor(private readonly notifications: TechnicianNotificationsService) {}
  @Get()
  @Header("Cache-Control", "private, no-store")
  async get(@CurrentPrincipal() principal: AuthPrincipal) {
    return { data: await this.notifications.capabilities(principal) };
  }
  @Post("subscribe")
  @Header("Cache-Control", "private, no-store")
  async subscribe(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body() body: unknown,
  ) {
    const parsed = Subscription.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException("请在微信订阅弹窗确认后登记");
    return {
      data: await this.notifications.subscribe(
        principal,
        parsed.data.requestId,
        parsed.data.templateId,
      ),
    };
  }
}
