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
  CustomerOrderConfirmationSchema,
  IdempotencyKeySchema,
  OrderCreateSchema,
  OrderQuoteRequestSchema,
} from "@zydj/contracts";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { SessionAuthGuard } from "../auth/session-auth.guard.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { OrdersService } from "./orders.service.js";

@Controller("orders")
@UseGuards(SessionAuthGuard)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post("quote")
  async quote(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body() body: unknown,
  ) {
    const parsed = OrderQuoteRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("报价参数无效");
    return {
      data: await this.orders.quote(principal, parsed.data.reservationId),
    };
  }

  @Post()
  async create(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const parsedBody = OrderCreateSchema.safeParse(body);
    const parsedKey = IdempotencyKeySchema.safeParse(idempotencyKey);
    if (!parsedBody.success || !parsedKey.success) {
      throw new BadRequestException("下单参数或幂等键无效");
    }
    const result = await this.orders.create(
      principal,
      parsedBody.data,
      parsedKey.data,
    );
    return {
      data: result.data,
      meta: { idempotentReplay: result.idempotentReplay },
    };
  }

  @Get()
  async list(@CurrentPrincipal() principal: AuthPrincipal) {
    const data = await this.orders.listOwn(principal);
    return { data, meta: { total: data.length } };
  }

  @Get(":id")
  async get(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("id") id: string,
  ) {
    return { data: await this.orders.getOwn(principal, id) };
  }

  @Get(":id/technician-location")
  async technicianLocation(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("id") id: string,
  ) {
    return { data: await this.orders.getTechnicianLocation(principal, id) };
  }

  @Post(":id/cancel")
  async cancel(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("id") id: string,
  ) {
    return { data: await this.orders.cancelOwn(principal, id) };
  }

  @Post(":id/confirm-completion")
  async confirmCompletion(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const parsed = CustomerOrderConfirmationSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("确认完成参数无效");
    return { data: await this.orders.confirmCompletion(principal, id) };
  }
}
