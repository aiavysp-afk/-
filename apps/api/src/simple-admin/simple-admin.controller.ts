import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Param,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  AdminCustomerDirectoryQuerySchema,
  AdminCustomerDirectorySchema,
  SimpleAdminOrderDetailSchema,
  SimpleAdminOrdersQuerySchema,
  SimpleAdminOrdersSchema,
  SimpleAdminTechniciansQuerySchema,
  SimpleAdminTechniciansSchema,
} from "@zydj/contracts";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { SessionAuthGuard } from "../auth/session-auth.guard.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { SimpleAdminService } from "./simple-admin.service.js";

@Controller("admin/organizations/:organizationId/simple")
@UseGuards(SessionAuthGuard)
export class SimpleAdminController {
  constructor(private readonly simple: SimpleAdminService) {}

  @Get("technicians")
  @Header("Cache-Control", "private, no-store, max-age=0")
  @Header("Pragma", "no-cache")
  async technicians(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
    @Query() query: unknown,
  ) {
    const parsed = SimpleAdminTechniciansQuerySchema.safeParse(query ?? {});
    if (!parsed.success) throw new BadRequestException("技师筛选参数无效");
    return {
      data: SimpleAdminTechniciansSchema.parse(
        await this.simple.technicians(principal, organizationId, parsed.data),
      ),
    };
  }

  @Get("orders")
  @Header("Cache-Control", "private, no-store, max-age=0")
  @Header("Pragma", "no-cache")
  async orders(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
    @Query() query: unknown,
  ) {
    const parsed = SimpleAdminOrdersQuerySchema.safeParse(query ?? {});
    if (!parsed.success) throw new BadRequestException("订单筛选参数无效");
    return {
      data: SimpleAdminOrdersSchema.parse(
        await this.simple.orders(principal, organizationId, parsed.data),
      ),
    };
  }

  @Get("orders/:orderId")
  @Header("Cache-Control", "private, no-store, max-age=0")
  @Header("Pragma", "no-cache")
  async order(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
    @Param("orderId") orderId: string,
  ) {
    return {
      data: SimpleAdminOrderDetailSchema.parse(
        await this.simple.orderDetail(principal, organizationId, orderId),
      ),
    };
  }

  @Get("users")
  @Header("Cache-Control", "private, no-store, max-age=0")
  @Header("Pragma", "no-cache")
  async users(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
    @Query() query: unknown,
  ) {
    const parsed = AdminCustomerDirectoryQuerySchema.safeParse(query ?? {});
    if (!parsed.success) throw new BadRequestException("用户筛选参数无效");
    return {
      data: AdminCustomerDirectorySchema.parse(
        await this.simple.users(principal, organizationId, parsed.data),
      ),
    };
  }
}
