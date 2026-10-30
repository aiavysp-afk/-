import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { TechnicianIntakeSubmissionSchema } from "@zydj/contracts";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { SessionAuthGuard } from "../auth/session-auth.guard.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { TechnicianIntakeService } from "./technician-intake.service.js";

@Controller("technician/intake")
export class PublicTechnicianIntakeController {
  constructor(private readonly intake: TechnicianIntakeService) {}
  @Post()
  @HttpCode(201)
  @Header("Cache-Control", "private, no-store, max-age=0")
  async submit(
    @Body() body: unknown,
    @Headers("idempotency-key") key: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const parsed = TechnicianIntakeSubmissionSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException(
        "请填写姓名、正确手机号，上传一张证书照片并同意资料使用说明",
      );
    return { data: await this.intake.submit(parsed.data, key, request.ip) };
  }
}

@Controller("admin/organizations/:organizationId/simple/intakes")
@UseGuards(SessionAuthGuard)
export class AdminTechnicianIntakeController {
  constructor(private readonly intake: TechnicianIntakeService) {}
  @Get(":intakeId/certificate")
  async certificate(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
    @Param("intakeId") id: string,
    @Res() response: FastifyReply,
  ) {
    const content = await this.intake.certificate(
      principal,
      organizationId,
      id,
    );
    return response
      .header("Cache-Control", "private, no-store, max-age=0")
      .header("Pragma", "no-cache")
      .header("Content-Type", "image/jpeg")
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Disposition", "inline")
      .send(content);
  }
  @Post(":intakeId/approve")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store, max-age=0")
  async approve(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
    @Param("intakeId") id: string,
    @Body() body: unknown,
  ) {
    const parsed = z
      .object({ expectedVersion: z.number().int().positive() })
      .strict()
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException("审核版本无效");
    return {
      data: await this.intake.review(
        principal,
        organizationId,
        id,
        "approve",
        parsed.data.expectedVersion,
      ),
    };
  }
  @Post(":intakeId/reject")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store, max-age=0")
  async reject(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
    @Param("intakeId") id: string,
    @Body() body: unknown,
  ) {
    const parsed = z
      .object({
        expectedVersion: z.number().int().positive(),
        reason: z.string().trim().min(2).max(500),
      })
      .strict()
      .safeParse(body);
    if (!parsed.success)
      throw new BadRequestException("审核版本或拒绝原因无效");
    return {
      data: await this.intake.review(
        principal,
        organizationId,
        id,
        "reject",
        parsed.data.expectedVersion,
        parsed.data.reason,
      ),
    };
  }
}
