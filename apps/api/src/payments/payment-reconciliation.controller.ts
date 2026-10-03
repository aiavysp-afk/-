import { Controller, Param, Post, UseGuards } from "@nestjs/common";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { SessionAuthGuard } from "../auth/session-auth.guard.js";
import { PaymentReconciliationService } from "./payment-reconciliation.service.js";

@Controller("admin/organizations/:organizationId/payments")
@UseGuards(SessionAuthGuard)
export class PaymentReconciliationController {
  constructor(private readonly reconciliation: PaymentReconciliationService) {}

  @Post("reconciliation/:date")
  async daily(@CurrentPrincipal() principal: AuthPrincipal, @Param("organizationId") organizationId: string, @Param("date") date: string) {
    return { data: await this.reconciliation.daily(principal, organizationId, date) };
  }
}
