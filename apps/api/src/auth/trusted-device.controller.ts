import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import { BrowserLoginService } from "./browser-login.service.js";
import { CurrentPrincipal } from "./current-principal.decorator.js";
import { SessionAuthGuard } from "./session-auth.guard.js";
import { TrustedDeviceService } from "./trusted-device.service.js";
import type { AuthPrincipal } from "./auth.types.js";

export const STAFF_TRUST_COOKIE = "__Host-zydj_staff_trust";
export function readStaffTrustCookie(
  header: string | undefined,
): string | null {
  if (!header || header.length > 16_384) return null;
  const matches = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${STAFF_TRUST_COOKIE}=`));
  if (matches.length !== 1) return null;
  const value = matches[0]!.slice(STAFF_TRUST_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
export function staffTrustCookie(token: string, expiresAt: string) {
  return `${STAFF_TRUST_COOKIE}=${token}; Path=/; Max-Age=604800; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; Secure; SameSite=Strict`;
}
export function clearStaffTrustCookie() {
  return `${STAFF_TRUST_COOKIE}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Strict`;
}

@Controller("auth/trusted-devices")
export class TrustedDeviceController {
  constructor(
    private readonly trust: TrustedDeviceService,
    private readonly browser: BrowserLoginService,
  ) {}

  @Get("config")
  @Header("Cache-Control", "no-store")
  config() {
    return { data: this.trust.configuration() };
  }

  @Get()
  @Header("Cache-Control", "no-store")
  @UseGuards(SessionAuthGuard)
  async list(@CurrentPrincipal() actor: AuthPrincipal) {
    return { data: await this.trust.list(actor) };
  }

  @Post()
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @UseGuards(SessionAuthGuard)
  async register(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Body() body: unknown,
    @Headers("origin") origin: string | undefined,
    @Headers("user-agent") agent: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    this.browser.assertBrowserOrigin(origin);
    const parsed = z
      .object({ label: z.string().trim().min(1).max(80).optional() })
      .strict()
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException("常用设备参数无效");
    const { device, token } = await this.trust.register(
      actor,
      parsed.data.label,
      agent,
    );
    reply.header("Set-Cookie", staffTrustCookie(token, device.expiresAt));
    return { data: { device } };
  }

  @Post("accept")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @UseGuards(SessionAuthGuard)
  async accept(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Body() body: unknown,
    @Headers("origin") origin: string | undefined,
    @Headers("user-agent") agent: string | undefined,
    @Headers("cookie") cookie: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    this.browser.assertBrowserOrigin(origin);
    if (!z.object({}).strict().safeParse(body).success)
      throw new BadRequestException("设备验证参数无效");
    const result = await this.trust.accept(
      actor,
      readStaffTrustCookie(cookie),
      agent,
    );
    if (!result.trusted) reply.header("Set-Cookie", clearStaffTrustCookie());
    return { data: result };
  }

  @Post("revoke")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @UseGuards(SessionAuthGuard)
  async revoke(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Body() body: unknown,
    @Headers("origin") origin: string | undefined,
  ) {
    this.browser.assertBrowserOrigin(origin);
    const parsed = z
      .object({ id: z.string().min(1).max(128) })
      .strict()
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException("设备撤销参数无效");
    return { data: await this.trust.revoke(actor, parsed.data.id) };
  }
}
