import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import { TechnicianH5OauthTicketExchangeSchema } from "@zydj/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { TechnicianH5AuthService } from "./technician-h5-auth.service.js";

const OAUTH_BINDING_COOKIE = "__Host-zydj-technician-h5-oauth";

@Controller("technician/h5-onboarding/wechat")
export class TechnicianH5AuthController {
  constructor(private readonly h5Auth: TechnicianH5AuthService) {}

  @Get("start")
  async start(@Res() reply: FastifyReply) {
    try {
      const result = await this.h5Auth.begin();
      return reply
        .header(
          "Set-Cookie",
          `${OAUTH_BINDING_COOKIE}=${encodeURIComponent(result.browserBinding)}; Max-Age=${result.maxAgeSeconds}; Path=/; HttpOnly; Secure; SameSite=Lax`,
        )
        .header("Cache-Control", "no-store")
        .code(302)
        .redirect(result.authorizeUrl);
    } catch (error) {
      if (!isConfigurationNotReady(error)) throw error;
      return reply
        .header("Cache-Control", "no-store")
        .code(302)
        .redirect(this.h5Auth.configurationUnavailableRedirectUrl());
    }
  }

  @Get("callback")
  async callback(
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    if (!code || !state)
      throw new BadRequestException("微信授权回调参数不完整");
    const redirectUrl = await this.h5Auth.callback(
      code,
      state,
      cookieValue(request.headers.cookie, OAUTH_BINDING_COOKIE),
    );
    return reply
      .header(
        "Set-Cookie",
        `${OAUTH_BINDING_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`,
      )
      .header("Cache-Control", "no-store")
      .code(302)
      .redirect(redirectUrl);
  }

  @Post("exchange")
  @HttpCode(200)
  async exchange(
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header("Cache-Control", "no-store").header("Pragma", "no-cache");
    const parsed = TechnicianH5OauthTicketExchangeSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("登录交换票据无效");
    return { data: await this.h5Auth.exchange(parsed.data.ticket) };
  }
}

function isConfigurationNotReady(error: unknown) {
  if (!(error instanceof HttpException)) return false;
  const response = error.getResponse();
  return (
    typeof response === "object" &&
    response !== null &&
    "code" in response &&
    response.code === "CONFIGURATION_NOT_READY"
  );
}

function cookieValue(header: string | undefined, name: string) {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}
