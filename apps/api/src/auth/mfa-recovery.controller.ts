import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { CurrentPrincipal } from "./current-principal.decorator.js";
import {
  MFA_RECOVERY_REJECTION_CODES,
  MfaRecoveryService,
} from "./mfa-recovery.service.js";
import { SessionAuthGuard } from "./session-auth.guard.js";
import type { AuthPrincipal } from "./auth.types.js";

const Identifier = z.string().min(1).max(128);
const RequestBody = z.object({ organizationId: Identifier }).strict();
const EmptyBody = z.object({}).strict();
const RejectBody = z
  .object({ reasonCode: z.enum(MFA_RECOVERY_REJECTION_CODES) })
  .strict();

@Controller()
@UseGuards(SessionAuthGuard)
export class MfaRecoveryController {
  constructor(private readonly recovery: MfaRecoveryService) {}

  @Post("auth/mfa/recovery-requests")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async request(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body() body: unknown,
  ) {
    const parsed = RequestBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException("恢复申请参数无效");
    return {
      data: await this.recovery.request(principal, parsed.data.organizationId),
    };
  }

  @Get("auth/mfa/recovery-requests")
  @Header("Cache-Control", "no-store")
  async own(@CurrentPrincipal() principal: AuthPrincipal) {
    return { data: await this.recovery.listOwn(principal) };
  }

  @Post("auth/mfa/recovery-requests/:requestId/cancel")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async cancel(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("requestId") rawRequestId: string,
    @Body() body: unknown,
  ) {
    const requestId = Identifier.safeParse(rawRequestId);
    if (!requestId.success || !EmptyBody.safeParse(body).success)
      throw new BadRequestException("取消参数无效");
    return { data: await this.recovery.cancel(principal, requestId.data) };
  }

  @Get("admin/organizations/:organizationId/mfa-recovery-requests")
  @Header("Cache-Control", "no-store")
  async reviewQueue(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") rawOrganizationId: string,
  ) {
    const organizationId = Identifier.safeParse(rawOrganizationId);
    if (!organizationId.success) throw new BadRequestException("组织参数无效");
    return {
      data: await this.recovery.listForReview(principal, organizationId.data),
    };
  }

  @Post(
    "admin/organizations/:organizationId/mfa-recovery-requests/:requestId/approve",
  )
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async approve(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") rawOrganizationId: string,
    @Param("requestId") rawRequestId: string,
    @Body() body: unknown,
  ) {
    const organizationId = Identifier.safeParse(rawOrganizationId),
      requestId = Identifier.safeParse(rawRequestId);
    if (
      !organizationId.success ||
      !requestId.success ||
      !EmptyBody.safeParse(body).success
    )
      throw new BadRequestException("复核参数无效");
    return {
      data: await this.recovery.approve(
        principal,
        organizationId.data,
        requestId.data,
      ),
    };
  }

  @Post(
    "admin/organizations/:organizationId/mfa-recovery-requests/:requestId/reject",
  )
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async reject(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") rawOrganizationId: string,
    @Param("requestId") rawRequestId: string,
    @Body() body: unknown,
  ) {
    const organizationId = Identifier.safeParse(rawOrganizationId),
      requestId = Identifier.safeParse(rawRequestId),
      parsed = RejectBody.safeParse(body);
    if (!organizationId.success || !requestId.success || !parsed.success)
      throw new BadRequestException("拒绝参数无效");
    return {
      data: await this.recovery.reject(
        principal,
        organizationId.data,
        requestId.data,
        parsed.data.reasonCode,
      ),
    };
  }
}
