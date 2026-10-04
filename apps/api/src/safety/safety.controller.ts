import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import {
  IdempotencyKeySchema,
  SafetyDutyRosterUpsertSchema,
  SafetyIncidentCloseSchema,
  SafetyIncidentCreateSchema,
} from "@zydj/contracts";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { SessionAuthGuard } from "../auth/session-auth.guard.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { SafetyService } from "./safety.service.js";

@Controller()
@UseGuards(SessionAuthGuard)
export class SafetyController {
  constructor(private readonly safety: SafetyService) {}

  @Post("admin/organizations/:organizationId/safety-duty-rosters")
  async configureRoster(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
    @Body() body: unknown,
  ) {
    const parsed = SafetyDutyRosterUpsertSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException("安全值班主备岗参数无效");
    return {
      data: await this.safety.configureRoster(
        principal,
        organizationId,
        parsed.data,
      ),
    };
  }

  @Get("admin/organizations/:organizationId/safety-duty-rosters/current")
  async getActiveRoster(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
  ) {
    return {
      data: await this.safety.getActiveRoster(principal, organizationId),
    };
  }

  @Get("admin/organizations/:organizationId/safety-duty-staff")
  async listEligibleResponders(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
  ) {
    const data = await this.safety.listEligibleResponders(
      principal,
      organizationId,
    );
    return { data, meta: { total: data.length } };
  }

  @Post("orders/:orderId/safety-incidents")
  async createIncident(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("orderId") orderId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const parsedBody = SafetyIncidentCreateSchema.safeParse(body);
    const parsedKey = IdempotencyKeySchema.safeParse(idempotencyKey);
    if (!parsedBody.success || !parsedKey.success)
      throw new BadRequestException("安全事件参数或幂等键无效");
    const result = await this.safety.createIncident(
      principal,
      orderId,
      parsedBody.data,
      parsedKey.data,
    );
    return {
      data: result.data,
      meta: { idempotentReplay: result.idempotentReplay },
    };
  }

  @Get("orders/:orderId/safety-incidents")
  async listOwn(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("orderId") orderId: string,
  ) {
    const data = await this.safety.listOwn(principal, orderId);
    return { data, meta: { total: data.length } };
  }

  @Get("admin/organizations/:organizationId/safety-incidents")
  async listStaff(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
  ) {
    const data = await this.safety.listStaff(principal, organizationId);
    return { data, meta: { total: data.length } };
  }

  @Post("admin/organizations/:organizationId/safety-incidents/:id/acknowledge")
  async acknowledge(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
    @Param("id") id: string,
  ) {
    return {
      data: await this.safety.acknowledge(principal, organizationId, id),
    };
  }

  @Post("admin/organizations/:organizationId/safety-incidents/:id/close")
  async close(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const parsed = SafetyIncidentCloseSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("安全事件关闭参数无效");
    return {
      data: await this.safety.close(principal, organizationId, id, parsed.data),
    };
  }
}
