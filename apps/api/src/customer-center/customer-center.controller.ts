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
  AccountDeletionRequestCreateSchema,
  CustomerCenterConfigUpdateSchema,
  CustomerCenterOrganizationQuerySchema,
  CustomerAddressCreateSchema,
  CustomerAddressUpdateSchema,
  CustomerCouponQuerySchema,
  CustomerFeedbackCreateSchema,
  StoredValueCardQuerySchema,
  AdminStoredValueLedgerQuerySchema,
} from "@zydj/contracts";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { SessionAuthGuard } from "../auth/session-auth.guard.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { CustomerCenterService } from "./customer-center.service.js";
import { CustomerCouponsService } from "./customer-coupons.service.js";
import { AdminStoredValueLedgerService } from "./admin-stored-value-ledger.service.js";

@Controller("customer-center")
@UseGuards(SessionAuthGuard)
export class CustomerCenterController {
  constructor(
    private readonly center: CustomerCenterService,
    private readonly customerCoupons: CustomerCouponsService,
  ) {}

  @Get("newcomer-coupons")
  async newcomerCoupons(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query("organizationId") organizationId?: string,
  ) {
    const query = CustomerCenterOrganizationQuerySchema.safeParse({
      organizationId,
    });
    if (!query.success) throw new BadRequestException("新人优惠券参数无效");
    return {
      data: await this.customerCoupons.newcomerOffer(
        principal,
        query.data.organizationId,
      ),
    };
  }

  @Post("newcomer-coupons")
  async claimNewcomerCoupons(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body() body: unknown,
  ) {
    const input = CustomerCenterOrganizationQuerySchema.safeParse(body ?? {});
    if (!input.success) throw new BadRequestException("新人优惠券参数无效");
    return {
      data: await this.customerCoupons.claimNewcomerCoupons(
        principal,
        input.data.organizationId,
      ),
    };
  }

  @Get()
  async overview(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query("organizationId") organizationId?: string,
  ) {
    const query = CustomerCenterOrganizationQuerySchema.safeParse({
      organizationId,
    });
    if (!query.success) throw new BadRequestException("客户中心参数无效");
    return {
      data: await this.center.overview(principal, query.data.organizationId),
    };
  }

  @Get("coupons")
  async coupons(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query("organizationId") organizationId?: string,
    @Query("status") status?: string,
  ) {
    const query = CustomerCouponQuerySchema.safeParse({
      organizationId,
      status,
    });
    if (!query.success) throw new BadRequestException("优惠券筛选参数无效");
    const data = await this.center.coupons(principal, query.data);
    return { data, meta: { total: data.length } };
  }

  @Get("wallet")
  async wallet(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query("organizationId") organizationId?: string,
    @Query("status") status?: string,
    @Query("type") type?: string,
  ) {
    const query = StoredValueCardQuerySchema.safeParse({
      organizationId,
      status,
      type,
    });
    if (!query.success) throw new BadRequestException("储值卡筛选参数无效");
    return { data: await this.center.wallet(principal, query.data) };
  }

  @Get("wallet/ledger")
  async ledger(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query("organizationId") organizationId?: string,
  ) {
    const query = CustomerCenterOrganizationQuerySchema.safeParse({
      organizationId,
    });
    if (!query.success) throw new BadRequestException("账单筛选参数无效");
    const result = await this.center.ledger(
      principal,
      query.data.organizationId,
    );
    return {
      data: result.items,
      meta: {
        total: result.items.length,
        organizationId: result.organizationId,
      },
    };
  }

  @Get("settings")
  async settings(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query("organizationId") organizationId?: string,
  ) {
    const query = CustomerCenterOrganizationQuerySchema.safeParse({
      organizationId,
    });
    if (!query.success) throw new BadRequestException("设置页参数无效");
    return {
      data: await this.center.settings(principal, query.data.organizationId),
    };
  }

  @Get("addresses")
  async addresses(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query("organizationId") organizationId?: string,
  ) {
    const query = CustomerCenterOrganizationQuerySchema.safeParse({
      organizationId,
    });
    if (!query.success) throw new BadRequestException("地址查询参数无效");
    const data = await this.center.addresses(
      principal,
      query.data.organizationId,
    );
    return { data, meta: { total: data.length } };
  }

  @Post("addresses")
  async createAddress(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body() body: unknown,
  ) {
    const input = CustomerAddressCreateSchema.safeParse(body);
    if (!input.success) throw new BadRequestException("地址参数无效");
    return { data: await this.center.createAddress(principal, input.data) };
  }

  @Patch("addresses/:id")
  async updateAddress(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const input = CustomerAddressUpdateSchema.safeParse(body);
    if (!input.success) throw new BadRequestException("地址参数无效");
    return {
      data: await this.center.updateAddress(principal, id, input.data),
    };
  }

  @Delete("addresses/:id")
  async deleteAddress(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("id") id: string,
  ) {
    return { data: await this.center.deleteAddress(principal, id) };
  }

  @Post("feedback")
  async feedback(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body() body: unknown,
  ) {
    const input = CustomerFeedbackCreateSchema.safeParse(body);
    if (!input.success) throw new BadRequestException("反馈内容参数无效");
    return { data: await this.center.createFeedback(principal, input.data) };
  }

  @Get("account-deletion")
  async accountDeletion(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query("organizationId") organizationId?: string,
  ) {
    const query = CustomerCenterOrganizationQuerySchema.safeParse({
      organizationId,
    });
    if (!query.success) throw new BadRequestException("注销查询参数无效");
    return {
      data: await this.center.accountDeletion(
        principal,
        query.data.organizationId,
      ),
    };
  }

  @Post("account-deletion")
  async requestAccountDeletion(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body() body: unknown,
  ) {
    const input = AccountDeletionRequestCreateSchema.safeParse(body);
    if (!input.success) throw new BadRequestException("注销申请参数无效");
    return {
      data: await this.center.requestAccountDeletion(principal, input.data),
    };
  }
}

@Controller("admin/organizations/:organizationId/customer-center")
@UseGuards(SessionAuthGuard)
export class AdminCustomerCenterController {
  constructor(
    private readonly center: CustomerCenterService,
    private readonly walletLedger: AdminStoredValueLedgerService,
  ) {}

  @Get("wallet-ledger")
  async ledger(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
    @Query() query: unknown,
  ) {
    const input = AdminStoredValueLedgerQuerySchema.safeParse(query ?? {});
    if (!input.success) throw new BadRequestException("账本筛选参数无效");
    return {
      data: await this.walletLedger.get(principal, organizationId, input.data),
    };
  }

  @Get("config")
  async config(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
  ) {
    return { data: await this.center.adminConfig(principal, organizationId) };
  }

  @Patch("config")
  async updateConfig(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
    @Body() body: unknown,
  ) {
    const input = CustomerCenterConfigUpdateSchema.safeParse(body);
    if (!input.success) throw new BadRequestException("客户中心配置参数无效");
    return {
      data: await this.center.updateAdminConfig(
        principal,
        organizationId,
        input.data,
      ),
    };
  }

  @Get("summary")
  async summary(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param("organizationId") organizationId: string,
  ) {
    return { data: await this.center.adminSummary(principal, organizationId) };
  }
}
