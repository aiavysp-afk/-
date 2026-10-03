import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UseGuards,
} from "@nestjs/common";
import { WechatMiniappLoginRequestSchema } from "@zydj/contracts";
import { AuthService } from "./auth.service.js";
import { CurrentPrincipal } from "./current-principal.decorator.js";
import { SessionAuthGuard } from "./session-auth.guard.js";
import type { AuthPrincipal } from "./auth.types.js";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("wechat-miniapp")
  @HttpCode(200)
  async loginWithWechat(@Body() body: unknown) {
    const parsed = WechatMiniappLoginRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("微信登录参数无效");
    return { data: await this.auth.loginWithWechat(parsed.data.code) };
  }

  @Get("me")
  @UseGuards(SessionAuthGuard)
  me(@CurrentPrincipal() principal: AuthPrincipal) {
    return {
      data: {
        id: principal.userId,
        displayName: principal.displayName,
        memberships: principal.memberships,
      },
    };
  }

  @Post("logout")
  @HttpCode(200)
  @UseGuards(SessionAuthGuard)
  async logout(@CurrentPrincipal() principal: AuthPrincipal) {
    return { data: await this.auth.logout(principal) };
  }
}
