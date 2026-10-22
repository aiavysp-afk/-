import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Req,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import {
  TechnicianPhoneSmsConfirmSchema,
  TechnicianPhoneSmsRequestSchema,
} from "@zydj/contracts";
import { TechnicianPhoneAuthService } from "./technician-phone-auth.service.js";

@Controller("auth/technician-phone")
export class TechnicianPhoneAuthController {
  constructor(private readonly login: TechnicianPhoneAuthService) {}
  @Get("capabilities")
  @Header("Cache-Control", "private, no-store")
  capabilities() {
    return { data: this.login.capabilities() };
  }
  @Post("sms/request")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  async request(@Body() body: unknown, @Req() request: FastifyRequest) {
    const parsed = TechnicianPhoneSmsRequestSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException("请勾选协议并输入正确手机号");
    return { data: await this.login.requestSms(parsed.data, request.ip) };
  }
  @Post("sms/confirm")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  async confirm(@Body() body: unknown, @Req() request: FastifyRequest) {
    const parsed = TechnicianPhoneSmsConfirmSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException("短信登录参数无效，请重新获取验证码");
    return { data: await this.login.confirmSms(parsed.data, request.ip) };
  }
}
