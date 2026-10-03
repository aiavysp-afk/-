import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { MfaService } from "./mfa.service.js";
import { SessionAuthGuard } from "./session-auth.guard.js";
import { CurrentPrincipal } from "./current-principal.decorator.js";
import type { AuthPrincipal } from "./auth.types.js";
const CodeSchema = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
@Controller("auth/mfa")
@UseGuards(SessionAuthGuard)
export class MfaController {
  constructor(private readonly mfa: MfaService) {}
  @Get()
  @Header("Cache-Control", "no-store")
  async status(@CurrentPrincipal() principal: AuthPrincipal) {
    return { data: await this.mfa.status(principal) };
  }
  @Post("enrollment")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async enroll(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body() body: unknown,
  ) {
    if (body !== undefined && !z.object({}).strict().safeParse(body).success)
      throw new BadRequestException("绑定参数无效");
    return { data: await this.mfa.enroll(principal) };
  }
  @Post("activate")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async activate(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body() body: unknown,
  ) {
    return { data: await this.mfa.verify(principal, this.code(body), true) };
  }
  @Post("verify")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async verify(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body() body: unknown,
  ) {
    return { data: await this.mfa.verify(principal, this.code(body), false) };
  }
  private code(body: unknown) {
    const parsed = CodeSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("请输入六位动态码");
    return parsed.data.code;
  }
}
