import { Controller, Param, Post, UseGuards } from "@nestjs/common";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { SessionAuthGuard } from "../auth/session-auth.guard.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { PaymentsService } from "./payments.service.js";

@Controller()
@UseGuards(SessionAuthGuard)
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post("orders/:id/payment-intent")
  async createIntent(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("id") orderId: string,
  ) {
    return { data: await this.payments.createIntent(principal, orderId) };
  }

  @Post("dev/payments/:id/succeed")
  async confirmMock(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("id") paymentId: string,
  ) {
    return { data: await this.payments.confirmMock(principal, paymentId) };
  }
}
