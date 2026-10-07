import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UseGuards,
} from "@nestjs/common";
import {
  SmsPhoneVerificationConfirmSchema,
  SmsPhoneVerificationRequestSchema,
  WechatMiniappLoginRequestSchema,
  WechatPhoneVerificationRequestSchema,
} from "@zydj/contracts";
import { AuthService } from "./auth.service.js";
import { CurrentPrincipal } from "./current-principal.decorator.js";
import { SessionAuthGuard } from "./session-auth.guard.js";
import type { AuthPrincipal } from "./auth.types.js";
import { PhoneVerificationSmsService } from "./phone-verification-sms.service.js";

@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly phoneSms: PhoneVerificationSmsService,
  ) {}

  @Post("wechat-miniapp")
  @HttpCode(200)
  async loginWithWechat(@Body() body: unknown) {
    const parsed = WechatMiniappLoginRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("微信登录参数无效");
    return { data: await this.auth.loginWithWechat(parsed.data.code) };
  }

  @Post("wechat-phone")
  @HttpCode(200)
  @UseGuards(SessionAuthGuard)
  async verifyWechatPhone(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body() body: unknown,
  ) {
    const parsed = WechatPhoneVerificationRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("手机号授权参数无效");
    return {
      data: await this.auth.verifyWechatPhone(principal, parsed.data.code),
    };
  }

  @Post("sms-phone/request")
  @HttpCode(200)
  @UseGuards(SessionAuthGuard)
  async requestSmsPhoneVerification(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body() body: unknown,
  ) {
    const parsed = SmsPhoneVerificationRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("手机号格式无效");
    return { data: await this.phoneSms.request(principal, parsed.data) };
  }

  @Post("sms-phone/confirm")
  @HttpCode(200)
  @UseGuards(SessionAuthGuard)
  async confirmSmsPhoneVerification(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body() body: unknown,
  ) {
    const parsed = SmsPhoneVerificationConfirmSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("短信验证参数无效");
    return { data: await this.phoneSms.confirm(principal, parsed.data) };
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
