import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ServiceAdminCreateSchema,
  ServiceAdminDeleteSchema,
  ServiceAdminUpdateSchema,
} from "@zydj/contracts";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { SessionAuthGuard } from "../auth/session-auth.guard.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { CatalogService } from "./catalog.service.js";

@Controller("admin/catalog/services")
@UseGuards(SessionAuthGuard)
export class AdminCatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  async list(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query("organizationId") organizationId?: string,
  ) {
    const data = await this.catalog.listForAdmin(principal, organizationId);
    return { data, meta: { total: data.length } };
  }

  @Post()
  async create(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body() body: unknown,
  ) {
    const parsed = ServiceAdminCreateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("服务项目参数无效");
    return { data: await this.catalog.create(principal, parsed.data) };
  }

  @Patch(":id")
  async update(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const parsed = ServiceAdminUpdateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("服务项目参数无效");
    return { data: await this.catalog.update(principal, id, parsed.data) };
  }

  @Post(":id/publish")
  async publish(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("id") id: string,
  ) {
    return { data: await this.catalog.setPublished(principal, id, true) };
  }

  @Delete(":id")
  async remove(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const parsed = ServiceAdminDeleteSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException("请刷新项目列表后重新删除");
    return { data: await this.catalog.remove(principal, id, parsed.data) };
  }

  @Post(":id/unpublish")
  async unpublish(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("id") id: string,
  ) {
    return { data: await this.catalog.setPublished(principal, id, false) };
  }
}
