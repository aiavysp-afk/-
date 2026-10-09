import {
  Controller,
  Get,
  Inject,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { SessionAuthGuard } from "../auth/session-auth.guard.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { FriendPaymentsService } from "./friend-payments.service.js";

@Controller()
@UseGuards(SessionAuthGuard)
export class FriendPaymentsController {
  constructor(
    @Inject(FriendPaymentsService)
    private readonly friends: FriendPaymentsService,
  ) {}
  @Post("orders/:id/friend-payment")
  async createShare(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("id") id: string,
  ) {
    return { data: await this.friends.createShare(principal, id) };
  }
  @Get("friend-payments/:token")
  async summary(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("token") token: string,
  ) {
    return { data: await this.friends.summary(principal, token) };
  }
  @Post("friend-payments/:token/payment-intent")
  async createIntent(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("token") token: string,
  ) {
    return { data: await this.friends.createIntent(principal, token) };
  }
  @Get("friend-payments/:token/payment-intent")
  async readIntent(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("token") token: string,
  ) {
    return { data: await this.friends.readIntent(principal, token) };
  }
  @Post("friend-payments/:token/reconcile")
  async reconcile(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("token") token: string,
  ) {
    return { data: await this.friends.reconcile(principal, token) };
  }
  @Get("payments/notifications")
  async notifications(@CurrentPrincipal() principal: AuthPrincipal) {
    return { data: await this.friends.notifications(principal) };
  }
}
