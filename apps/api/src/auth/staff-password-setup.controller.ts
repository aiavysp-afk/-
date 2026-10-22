import {
  BadRequestException,
  Body,
  Controller,
  Header,
  Headers,
  HttpCode,
  Post,
  Req,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { isStaffPasswordValid } from "./password-hash.js";
import { normalizeStaffLoginAlias } from "./staff-login-account.js";
import { StaffPasswordSetupService } from "./staff-password-setup.service.js";

@Controller("auth/staff-password/setup")
export class StaffPasswordSetupController {
  constructor(private readonly setup: StaffPasswordSetupService) {}

  @Post("request")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async request(
    @Body() body: unknown,
    @Headers("origin") origin: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    this.setup.assertBrowserOrigin(origin);
    const parsed = z
      .object({ phone: z.string().regex(/^1[3-9]\d{9}$/) })
      .strict()
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException("手机号格式无效");
    return {
      data: await this.setup.request(
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
    this.setup.assertBrowserOrigin(origin);
    const parsed = z
      .object({
        challengeId: z.string().uuid(),
        challengeSecret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        code: z.string().regex(/^\d{6}$/),
        loginAlias: z
          .string()
          .max(128)
          .transform((value, context) => {
            const alias = normalizeStaffLoginAlias(value);
            if (alias === null) {
              context.addIssue({ code: "custom", message: "登录名格式无效" });
              return z.NEVER;
            }
            return alias;
          })
          .optional(),
        password: z.string().min(12).max(128).refine(isStaffPasswordValid),
      })
      .strict()
      .safeParse(body);
    if (!parsed.success)
      throw new BadRequestException(
        "首次开通参数格式无效；密码须为12至128个字符",
      );
    return {
      data: await this.setup.confirm(
        parsed.data,
        request.raw.socket.remoteAddress ?? "unknown",
      ),
    };
  }
}
