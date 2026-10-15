import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  AdminCustomerDirectoryQuerySchema,
  AdminCustomerDirectorySchema,
  AdminCustomerPhoneRevealRequestSchema,
  AdminCustomerPhoneRevealSchema,
} from "@zydj/contracts";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { SessionAuthGuard } from "../auth/session-auth.guard.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { AdminCustomerDirectoryService } from "./admin-customer-directory.service.js";

@Controller("admin/organizations/:organizationId/customer-center/customers")
@UseGuards(SessionAuthGuard)
export class AdminCustomerDirectoryController {
  constructor(private readonly directory: AdminCustomerDirectoryService) {}

  @Get()
  @Header("Cache-Control", "private, no-store, max-age=0")
  @Header("Pragma", "no-cache")
  async list(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
    @Query() query: unknown,
  ) {
    const parsed = AdminCustomerDirectoryQuerySchema.safeParse(query ?? {});
    if (!parsed.success) throw new BadRequestException("客户列表筛选参数无效");
    return {
      data: AdminCustomerDirectorySchema.parse(
        await this.directory.list(principal, organizationId, parsed.data),
      ),
    };
  }

  @Post(":customerId/reveal-phone")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store, max-age=0")
  @Header("Pragma", "no-cache")
  async revealPhone(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
    @Param("customerId") customerId: string,
    @Body() body: unknown,
  ) {
    const parsed = AdminCustomerPhoneRevealRequestSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException("请填写 4 至 200 字的手机号查看用途");
    return {
      data: AdminCustomerPhoneRevealSchema.parse(
        await this.directory.revealPhone(
          principal,
          organizationId,
          customerId,
          parsed.data,
        ),
      ),
    };
  }
}
