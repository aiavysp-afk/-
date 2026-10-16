import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Post,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { CurrentPrincipal } from "./current-principal.decorator.js";
import { SessionAuthGuard } from "./session-auth.guard.js";
import { StaffPasswordService } from "./staff-password.service.js";
import type { AuthPrincipal } from "./auth.types.js";
import {
  normalizeStaffLoginAccount,
  normalizeStaffLoginAlias,
} from "./staff-login-account.js";

const Password = z
  .string()
  .min(12)
  .max(128)
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= 512 && !value.includes("\0"),
  );
const LoginAlias = z
  .string()
  .max(128)
  .transform((value, context) => {
    const normalized = normalizeStaffLoginAlias(value);
    if (normalized === null) {
      context.addIssue({ code: "custom", message: "登录名格式无效" });
      return z.NEVER;
    }
    return normalized;
  });
const Account = z
  .string()
  .max(128)
  .transform((value, context) => {
    const normalized = normalizeStaffLoginAccount(value);
    if (normalized === null) {
      context.addIssue({ code: "custom", message: "登录账号格式无效" });
      return z.NEVER;
    }
    return normalized.value;
  });

@Controller("auth/staff-password")
export class StaffPasswordController {
  constructor(private readonly passwords: StaffPasswordService) {}

  @Get("config")
  @Header("Cache-Control", "no-store")
  configuration() {
    return { data: this.passwords.configuration() };
  }

  @Get()
  @Header("Cache-Control", "no-store")
  @UseGuards(SessionAuthGuard)
  async status(@CurrentPrincipal() principal: AuthPrincipal) {
    return { data: await this.passwords.status(principal) };
  }

  @Put()
  @Header("Cache-Control", "no-store")
  @UseGuards(SessionAuthGuard)
  async setPassword(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body() body: unknown,
    @Headers("origin") origin: string | undefined,
  ) {
    this.passwords.assertBrowserOrigin(origin);
    const parsed = z
      .object({ password: Password, loginAlias: LoginAlias.optional() })
      .strict()
      .safeParse(body);
    if (!parsed.success)
      throw new BadRequestException(
        "密码须为12至128个字符；登录名须为4至32位英文字母、数字、下划线或短横线，且以英文字母开头",
      );
    return {
      data:
        parsed.data.loginAlias === undefined
          ? await this.passwords.setPassword(principal, parsed.data.password)
          : await this.passwords.setPassword(
              principal,
              parsed.data.password,
              undefined,
              parsed.data.loginAlias,
            ),
    };
  }

  @Post("login")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async login(
    @Body() body: unknown,
    @Headers("origin") origin: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    this.passwords.assertBrowserOrigin(origin);
    const parsed = z
      .object({
        account: Account,
        password: Password,
      })
      .strict()
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException("登录参数格式无效");
    return {
      data: await this.passwords.login(
        parsed.data,
        request.raw.socket.remoteAddress ?? "unknown",
      ),
    };
  }

  @Post("confirm")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async confirm(
    @Body() body: unknown,
    @Headers("origin") origin: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    this.passwords.assertBrowserOrigin(origin);
    const parsed = z
      .object({
        challengeId: z.string().uuid(),
        challengeSecret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        code: z.string().regex(/^\d{6}$/),
      })
      .strict()
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException("短信登录参数格式无效");
    return {
      data: await this.passwords.confirm(
        parsed.data,
        request.raw.socket.remoteAddress ?? "unknown",
      ),
    };
  }
}
