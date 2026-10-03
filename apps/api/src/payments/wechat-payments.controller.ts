import { Controller, HttpException, Inject, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { SessionAuthGuard } from "../auth/session-auth.guard.js";
import { WechatPaymentsService } from "./wechat-payments.service.js";

@Controller("payments")
export class WechatPaymentsController {
  constructor(@Inject(WechatPaymentsService) private readonly payments: WechatPaymentsService) {}

  @Post("wechat/notify")
  async notify(@Req() request: RawBodyRequest<FastifyRequest>, @Res() reply: FastifyReply) {
    try {
      if (!request.rawBody) return reply.status(400).send({ code: "FAIL", message: "缺少原始通知内容" });
      await this.payments.notify(request.rawBody, request.headers);
      return reply.status(204).send();
    } catch (error) {
      return reply.status(error instanceof HttpException ? error.getStatus() : 500).send({ code: "FAIL", message: "通知未处理，请重试" });
    }
  }

  @Post(":id/reconcile")
  @UseGuards(SessionAuthGuard)
  async reconcile(@CurrentPrincipal() principal: AuthPrincipal, @Param("id") paymentId: string) {
    return { data: await this.payments.reconcile(principal, paymentId) };
  }
}
