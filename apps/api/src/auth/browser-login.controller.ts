import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { BrowserLoginService } from "./browser-login.service.js";
import { SessionAuthGuard } from "./session-auth.guard.js";
import { CurrentPrincipal } from "./current-principal.decorator.js";
import type { AuthPrincipal } from "./auth.types.js";
const pairCode = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
const Device = z
  .object({ pairCode, browserSecret: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .strict();
@Controller("auth/browser-login")
export class BrowserLoginController {
  constructor(private readonly login: BrowserLoginService) {}
  @Get("config") @Header("Cache-Control", "no-store") config() {
    return { data: this.login.configuration() };
  }
  @Post("create")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async create(
    @Body() body: unknown,
    @Headers("origin") origin: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    this.empty(body);
    this.login.assertBrowserOrigin(origin);
    return {
      data: await this.login.create(
        request.raw.socket.remoteAddress ?? "unknown",
      ),
    };
  }
  @Post("inspect")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @UseGuards(SessionAuthGuard)
  async inspect(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Body() body: unknown,
  ) {
    const p = z.object({ pairCode }).strict().safeParse(body);
    if (!p.success) throw new BadRequestException("配对码无效");
    return { data: await this.login.inspect(actor, p.data.pairCode) };
  }
  @Post("approve")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @UseGuards(SessionAuthGuard)
  async approve(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Body() body: unknown,
  ) {
    const p = z
      .object({ pairCode, confirmationCode: z.string().regex(/^\d{6}$/) })
      .strict()
      .safeParse(body);
    if (!p.success) throw new BadRequestException("配对确认参数无效");
    return {
      data: await this.login.approve(
        actor,
        p.data.pairCode,
        p.data.confirmationCode,
      ),
    };
  }
  @Post("poll")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async poll(
    @Body() body: unknown,
    @Headers("origin") origin: string | undefined,
  ) {
    const p = this.device(body, origin);
    return { data: await this.login.poll(p.pairCode, p.browserSecret) };
  }
  @Post("claim")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async claim(
    @Body() body: unknown,
    @Headers("origin") origin: string | undefined,
  ) {
    const p = this.device(body, origin);
    return { data: await this.login.claim(p.pairCode, p.browserSecret) };
  }
  @Post("cancel")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async cancel(
    @Body() body: unknown,
    @Headers("origin") origin: string | undefined,
  ) {
    const p = this.device(body, origin);
    return { data: await this.login.cancel(p.pairCode, p.browserSecret) };
  }
  private empty(body: unknown) {
    if (!z.object({}).strict().safeParse(body).success)
      throw new BadRequestException("登录参数无效");
  }
  private device(body: unknown, origin?: string) {
    this.login.assertBrowserOrigin(origin);
    const p = Device.safeParse(body);
    if (!p.success) throw new BadRequestException("登录配对参数无效");
    return p.data;
  }
}
