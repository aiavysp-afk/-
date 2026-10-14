import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import {
  CustomerSmsLoginConfirmSchema,
  CustomerSmsLoginRequestSchema,
  CustomerWechatPhoneLoginRequestSchema,
} from "@zydj/contracts";
import { CustomerLoginService } from "./customer-login.service.js";

@Controller("auth/customer-login")
export class CustomerLoginController {
  constructor(private readonly login: CustomerLoginService) {}

  @Get("capabilities")
  capabilities() {
    return { data: this.login.capabilities() };
  }

  @Post("wechat-phone")
  @HttpCode(200)
  async wechatPhone(@Body() body: unknown) {
    const parsed = CustomerWechatPhoneLoginRequestSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException("请勾选协议并完成微信手机号授权");
    return { data: await this.login.wechatPhone(parsed.data) };
  }

  @Post("sms/request")
  @HttpCode(200)
  async requestSms(@Body() body: unknown, @Req() request: FastifyRequest) {
    const parsed = CustomerSmsLoginRequestSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException("请勾选协议并输入正确手机号");
    // IP comes from the trusted Fastify/Nginx request, not a body/header supplied here.
    return { data: await this.login.requestSms(parsed.data, request.ip) };
  }

  @Post("sms/confirm")
  @HttpCode(200)
  async confirmSms(@Body() body: unknown, @Req() request: FastifyRequest) {
    const parsed = CustomerSmsLoginConfirmSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException("短信登录参数无效，请重新获取验证码");
    return { data: await this.login.confirmSms(parsed.data, request.ip) };
  }
}
