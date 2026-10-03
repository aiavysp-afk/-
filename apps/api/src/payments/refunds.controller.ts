import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
  type RawBodyRequest,
} from "@nestjs/common";
import { RefundRequestSchema, RefundReviewSchema } from "@zydj/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { SessionAuthGuard } from "../auth/session-auth.guard.js";
import { RefundsService } from "./refunds.service.js";

@Controller()
export class RefundsController {
  constructor(
    @Inject(RefundsService) private readonly refunds: RefundsService,
  ) {}

  @Get("orders/:orderId/refunds")
  @UseGuards(SessionAuthGuard)
  async listOwn(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("orderId") orderId: string,
  ) {
    return { data: await this.refunds.listOwn(principal, orderId) };
  }

  @Post("orders/:orderId/refunds")
  @UseGuards(SessionAuthGuard)
  async requestOwn(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("orderId") orderId: string,
    @Headers("idempotency-key") key: string,
    @Body() body: unknown,
  ) {
    if (
      body !== undefined &&
      body !== null &&
      (typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length)
    )
      throw new BadRequestException("客户退款金额和原因由服务器判定");
    return { data: await this.refunds.requestOwn(principal, orderId, key) };
  }

  @Get("admin/organizations/:organizationId/payments")
  @UseGuards(SessionAuthGuard)
  async listPayments(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
  ) {
    return { data: await this.refunds.listPayments(principal, organizationId) };
  }

  @Get("admin/organizations/:organizationId/payments/:paymentId/refunds")
  @UseGuards(SessionAuthGuard)
  async listStaff(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
    @Param("paymentId") paymentId: string,
  ) {
    return {
      data: await this.refunds.listStaff(principal, organizationId, paymentId),
    };
  }

  @Post("admin/organizations/:organizationId/payments/:paymentId/refunds")
  @UseGuards(SessionAuthGuard)
  async request(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
    @Param("paymentId") paymentId: string,
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: string,
  ) {
    const parsed = RefundRequestSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException("退款申请参数无效，金额由服务器计算");
    return {
      data: await this.refunds.request(
        principal,
        organizationId,
        paymentId,
        parsed.data,
        idempotencyKey,
      ),
    };
  }

  @Post("admin/organizations/:organizationId/refunds/:id/approve")
  @HttpCode(200)
  @UseGuards(SessionAuthGuard)
  async approve(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const parsed = RefundReviewSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("复核参数无效");
    return {
      data: await this.refunds.review(
        principal,
        organizationId,
        id,
        true,
        parsed.data,
      ),
    };
  }

  @Post("admin/organizations/:organizationId/refunds/:id/reject")
  @HttpCode(200)
  @UseGuards(SessionAuthGuard)
  async reject(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const parsed = RefundReviewSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("复核参数无效");
    return {
      data: await this.refunds.review(
        principal,
        organizationId,
        id,
        false,
        parsed.data,
      ),
    };
  }

  @Post("admin/organizations/:organizationId/refunds/:id/submit")
  @HttpCode(200)
  @UseGuards(SessionAuthGuard)
  async submit(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
    @Param("id") id: string,
  ) {
    return { data: await this.refunds.submit(principal, organizationId, id) };
  }

  @Post("admin/organizations/:organizationId/refunds/:id/reconcile")
  @HttpCode(200)
  @UseGuards(SessionAuthGuard)
  async reconcile(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
    @Param("id") id: string,
  ) {
    return {
      data: await this.refunds.reconcile(principal, organizationId, id),
    };
  }

  @Post("dev/organizations/:organizationId/refunds/:id/succeed")
  @HttpCode(200)
  @UseGuards(SessionAuthGuard)
  async confirmMock(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
    @Param("id") id: string,
  ) {
    return {
      data: await this.refunds.confirmMock(principal, organizationId, id),
    };
  }

  @Post("payments/wechat/refund-notify")
  async notify(
    @Req() request: RawBodyRequest<FastifyRequest>,
    @Res() reply: FastifyReply,
  ) {
    try {
      if (!request.rawBody)
        return reply
          .status(400)
          .send({ code: "FAIL", message: "缺少原始通知内容" });
      await this.refunds.notify(request.rawBody, request.headers);
      return reply.status(204).send();
    } catch (error) {
      return reply
        .status(error instanceof HttpException ? error.getStatus() : 500)
        .send({ code: "FAIL", message: "退款通知未处理，请重试" });
    }
  }
}
