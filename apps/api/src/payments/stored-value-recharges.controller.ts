import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import {
  IdempotencyKeySchema,
  CustomerCenterOrganizationQuerySchema,
  StoredValueRechargeCreateSchema,
} from "@zydj/contracts";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { SessionAuthGuard } from "../auth/session-auth.guard.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { StoredValueRechargesService } from "./stored-value-recharges.service.js";

@Controller("customer-center/wallet")
@UseGuards(SessionAuthGuard)
export class StoredValueRechargesController {
  constructor(private readonly recharges: StoredValueRechargesService) {}

  @Post("recharges")
  async create(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = StoredValueRechargeCreateSchema.safeParse(body);
    const key = IdempotencyKeySchema.safeParse(idempotencyKey);
    if (!input.success || !key.success)
      throw new BadRequestException("充值金额或幂等键无效");
    return {
      data: await this.recharges.createIntent(
        principal,
        input.data,
        key.data,
      ),
    };
  }

  @Post("recharges/:id/reconcile")
  async reconcile(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("id") rechargeId: string,
  ) {
    return { data: await this.recharges.reconcile(principal, rechargeId) };
  }

  @Post("first-recharge-reward/claim")
  async claimReward(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body() body: unknown,
  ) {
    const input = CustomerCenterOrganizationQuerySchema.safeParse(body);
    if (!input.success) throw new BadRequestException("红包领取参数无效");
    return {
      data: await this.recharges.claimFirstRechargeReward(principal, input.data.organizationId),
    };
  }
}
