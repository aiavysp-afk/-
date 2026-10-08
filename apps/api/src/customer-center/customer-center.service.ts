import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import {
  AccountDeletionRequestStatus,
  CustomerCouponStatus as PrismaCustomerCouponStatus,
  CustomerFeedbackStatus,
  OrderStatus,
  type Prisma,
} from "@prisma/client";
import type {
  AccountDeletionRequest,
  AccountDeletionRequestCreate,
  AdminCustomerCenterSummary,
  CustomerCenterConfigUpdate,
  CustomerCenterContent,
  CustomerCenterOrderCounts,
  CustomerCenterOverview,
  CustomerAddress,
  CustomerAddressCreate,
  CustomerAddressUpdate,
  CustomerCoupon,
  CustomerCouponStatus,
  CustomerFeedback,
  CustomerFeedbackCreate,
  CustomerSettings,
  CustomerWallet,
  StoredValueCardQuerySchema,
  StoredValueTransaction,
} from "@zydj/contracts";
import type { z } from "zod";
import { AccessControlService } from "../auth/access-control.service.js";
import { AuthCryptoService } from "../auth/auth-crypto.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { PrismaService } from "../database/prisma.service.js";

type CardQuery = z.infer<typeof StoredValueCardQuerySchema>;

const DEFAULT_CONTENT = {
  levelLabel: "普通用户",
  customerServicePhone: null,
  cityNewsTitle: "城市快讯",
  cityNewsContent: "中原到家持续为郑州用户提供规范上门服务",
  appBannerTitle: "中原到家小程序",
  appBannerSubtitle: "无需下载 APP，微信内即可预约",
  appDownloadUrl: null,
  safeguardItems: ["价格透明", "服务留痕", "售后保障"],
} as const;

const IN_PROGRESS_STATUSES = [
  OrderStatus.PAID,
  OrderStatus.DISPATCHING,
  OrderStatus.ASSIGNED,
  OrderStatus.EN_ROUTE,
  OrderStatus.ARRIVED,
  OrderStatus.IN_SERVICE,
  OrderStatus.AWAITING_CONFIRMATION,
];

@Injectable()
export class CustomerCenterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly crypto: AuthCryptoService,
  ) {}

  async overview(
    principal: AuthPrincipal,
    requestedOrganizationId?: string,
  ): Promise<CustomerCenterOverview> {
    const organizationId = await this.resolveOrganizationId(
      principal.userId,
      requestedOrganizationId,
    );
    const now = new Date();
    const [user, content, orders, availableCouponCount, account] =
      await Promise.all([
        this.prisma.user.findUnique({
          where: { id: principal.userId },
          select: {
            id: true,
            displayName: true,
            createdAt: true,
            phoneEncrypted: true,
            phoneVerifiedAt: true,
          },
        }),
        this.readContent(organizationId),
        this.orderCounts({ organizationId, customerId: principal.userId }),
        this.prisma.customerCoupon.count({
          where: {
            organizationId,
            customerId: principal.userId,
            status: PrismaCustomerCouponStatus.AVAILABLE,
            validFrom: { lte: now },
            expiresAt: { gt: now },
          },
        }),
        this.prisma.storedValueAccount.findUnique({
          where: {
            organizationId_customerId: {
              organizationId,
              customerId: principal.userId,
            },
          },
          select: {
            _count: {
              select: { cards: { where: { status: "AVAILABLE" } } },
            },
          },
        }),
      ]);
    if (!user) throw new NotFoundException("用户不存在");

    return {
      organizationId,
      profile: {
        userId: user.id,
        displayName: user.displayName,
        avatarUrl: null,
        levelLabel: content.levelLabel,
        registeredAt: user.createdAt.toISOString(),
        phoneVerified: Boolean(user.phoneEncrypted && user.phoneVerifiedAt),
      },
      benefits: {
        availableCouponCount,
        availableCardCount: account?._count.cards ?? 0,
        maskedBalance: "****",
      },
      orders,
      content,
    };
  }

  async coupons(
    principal: AuthPrincipal,
    query: { organizationId?: string; status?: CustomerCouponStatus },
  ): Promise<CustomerCoupon[]> {
    const organizationId = await this.resolveOrganizationId(
      principal.userId,
      query.organizationId,
    );
    const now = new Date();
    const where: Prisma.CustomerCouponWhereInput = {
      organizationId,
      customerId: principal.userId,
    };
    if (query.status === "AVAILABLE") {
      Object.assign(where, {
        status: PrismaCustomerCouponStatus.AVAILABLE,
        validFrom: { lte: now },
        expiresAt: { gt: now },
      });
    } else if (query.status === "USED") {
      where.status = PrismaCustomerCouponStatus.USED;
    } else if (query.status === "EXPIRED") {
      where.OR = [
        { status: PrismaCustomerCouponStatus.EXPIRED },
        {
          status: PrismaCustomerCouponStatus.AVAILABLE,
          expiresAt: { lte: now },
        },
      ];
    }
    const rows = await this.prisma.customerCoupon.findMany({
      where,
      orderBy: [{ expiresAt: "asc" }, { createdAt: "desc" }],
      take: 100,
    });
    return rows.map((row) => ({
      id: row.id,
      organizationId: row.organizationId,
      title: row.title,
      amountFen: this.safeMoney(row.amountFen),
      minimumSpendFen: this.safeMoney(row.minimumSpendFen),
      applicability: row.applicability,
      canApplyToTravelFee: row.canApplyToTravelFee,
      validFrom: row.validFrom.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      status:
        row.status === PrismaCustomerCouponStatus.AVAILABLE &&
        row.expiresAt.getTime() <= now.getTime()
          ? "EXPIRED"
          : row.status,
      usedAt: row.usedAt?.toISOString() ?? null,
    }));
  }

  async wallet(
    principal: AuthPrincipal,
    query: CardQuery,
  ): Promise<CustomerWallet> {
    const organizationId = await this.resolveOrganizationId(
      principal.userId,
      query.organizationId,
    );
    const cardWhere: Prisma.StoredValueCardWhereInput = {};
    if (query.status) cardWhere.status = query.status;
    if (query.type) cardWhere.type = query.type;
    const account = await this.prisma.storedValueAccount.findUnique({
      where: {
        organizationId_customerId: {
          organizationId,
          customerId: principal.userId,
        },
      },
      include: {
        cards: {
          where: cardWhere,
          orderBy: [{ status: "asc" }, { createdAt: "desc" }],
        },
      },
    });
    return {
      organizationId,
      balanceFen: this.safeMoney(account?.balanceFen ?? 0n),
      cards: (account?.cards ?? []).map((card) => ({
        id: card.id,
        name: card.name,
        type: card.type,
        balanceFen: this.safeMoney(card.balanceFen),
        status: card.status,
        expiresAt: card.expiresAt?.toISOString() ?? null,
      })),
      recharge: {
        enabled: false,
        reason:
          "四档充值金额已配置；充值支付、微信回调与入账核对完成前不会开放扣款",
        plans: [599_00, 888_00, 1_198_00, 2_888_00].map((amountFen) => ({
          amountFen,
          label: `充值 ${amountFen / 100} 元`,
        })),
        firstRechargeReward: {
          enabled: false,
          reason: "首充红包须在真实支付回调成功后发放，当前未开放",
        },
      },
      withdrawal: {
        enabled: false,
        minimumFen: 1_000_00,
        stepFen: 1_000_00,
        reviewRequired: true,
        reason:
          "未验证微信商户转账与实名审核能力，暂不提供实时到账；提现申请必须审核并保留账务记录",
      },
      checkIn: {
        enabled: false,
        rewardUnit: "POINTS",
        reason:
          "签到奖励只能使用不可提现积分；未配置封顶与风控前不启用每日翻倍",
      },
    };
  }

  async ledger(
    principal: AuthPrincipal,
    requestedOrganizationId?: string,
  ): Promise<{ organizationId: string; items: StoredValueTransaction[] }> {
    const organizationId = await this.resolveOrganizationId(
      principal.userId,
      requestedOrganizationId,
    );
    const account = await this.prisma.storedValueAccount.findUnique({
      where: {
        organizationId_customerId: {
          organizationId,
          customerId: principal.userId,
        },
      },
      include: {
        transactions: { orderBy: { occurredAt: "desc" }, take: 100 },
      },
    });
    return {
      organizationId,
      items: (account?.transactions ?? []).map((entry) => ({
        id: entry.id,
        type: entry.type,
        changeFen: this.safeSignedMoney(entry.changeFen),
        balanceAfterFen: this.safeMoney(entry.balanceAfterFen),
        description: entry.description,
        occurredAt: entry.occurredAt.toISOString(),
      })),
    };
  }

  async settings(
    principal: AuthPrincipal,
    requestedOrganizationId?: string,
  ): Promise<CustomerSettings> {
    const organizationId = await this.resolveOrganizationId(
      principal.userId,
      requestedOrganizationId,
    );
    const [user, content] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: principal.userId },
        select: {
          id: true,
          displayName: true,
          phoneEncrypted: true,
          phoneVerifiedAt: true,
          createdAt: true,
        },
      }),
      this.readContent(organizationId),
    ]);
    if (!user) throw new NotFoundException("用户不存在");
    return {
      organizationId,
      userId: user.id,
      displayName: user.displayName,
      maskedPhone: user.phoneEncrypted
        ? this.maskPhone(this.crypto.decrypt(user.phoneEncrypted))
        : null,
      phoneVerified: Boolean(user.phoneEncrypted && user.phoneVerifiedAt),
      registeredAt: user.createdAt.toISOString(),
      customerServicePhone: content.customerServicePhone,
    };
  }

  async addresses(
    principal: AuthPrincipal,
    requestedOrganizationId?: string,
  ): Promise<CustomerAddress[]> {
    const organizationId = await this.resolveOrganizationId(
      principal.userId,
      requestedOrganizationId,
    );
    const rows = await this.prisma.customerAddress.findMany({
      where: { organizationId, customerId: principal.userId },
      orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
      take: 50,
    });
    return rows.map((row) => this.toAddress(row));
  }

  async createAddress(
    principal: AuthPrincipal,
    input: CustomerAddressCreate,
  ): Promise<CustomerAddress> {
    const organizationId = await this.resolveOrganizationId(
      principal.userId,
      input.organizationId,
    );
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${principal.userId} FOR UPDATE`;
      const count = await tx.customerAddress.count({
        where: { organizationId, customerId: principal.userId },
      });
      if (count >= 50) {
        throw new BadRequestException("每个服务组织最多保存 50 个地址");
      }
      const isDefault = input.isDefault === true || count === 0;
      if (isDefault) {
        await tx.customerAddress.updateMany({
          where: { organizationId, customerId: principal.userId },
          data: { isDefault: false },
        });
      }
      const created = await tx.customerAddress.create({
        data: {
          organizationId,
          customerId: principal.userId,
          contactNameEncrypted: this.crypto.encrypt(input.contactName),
          phoneEncrypted: this.crypto.encrypt(input.phone),
          detailEncrypted: this.crypto.encrypt(input.detail),
          latitude: input.latitude,
          longitude: input.longitude,
          coordinateSystem: input.coordinateSystem,
          isDefault,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId,
          action: "CUSTOMER_ADDRESS_CREATED",
          resourceType: "CustomerAddress",
          resourceId: created.id,
          metadata: { isDefault, coordinateSystem: input.coordinateSystem },
        },
      });
      return created;
    });
    return this.toAddress(row);
  }

  async updateAddress(
    principal: AuthPrincipal,
    id: string,
    input: CustomerAddressUpdate,
  ): Promise<CustomerAddress> {
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "CustomerAddress" WHERE "id" = ${id} FOR UPDATE`;
      const current = await tx.customerAddress.findUnique({ where: { id } });
      if (!current) throw new NotFoundException("地址不存在");
      if (current.customerId !== principal.userId)
        throw new ForbiddenException("不能修改其他用户的地址");
      if (current.isDefault && input.isDefault === false) {
        throw new ConflictException("请先将其他地址设为默认地址");
      }
      if (input.isDefault === true) {
        await tx.customerAddress.updateMany({
          where: {
            organizationId: current.organizationId,
            customerId: principal.userId,
            id: { not: id },
          },
          data: { isDefault: false },
        });
      }
      const data: Prisma.CustomerAddressUpdateInput = {};
      if (input.contactName !== undefined)
        data.contactNameEncrypted = this.crypto.encrypt(input.contactName);
      if (input.phone !== undefined)
        data.phoneEncrypted = this.crypto.encrypt(input.phone);
      if (input.detail !== undefined)
        data.detailEncrypted = this.crypto.encrypt(input.detail);
      if (input.latitude !== undefined) {
        data.latitude = input.latitude;
        data.longitude = input.longitude;
        data.coordinateSystem = input.coordinateSystem;
      }
      if (input.isDefault !== undefined) data.isDefault = input.isDefault;
      const updated = await tx.customerAddress.update({ where: { id }, data });
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId: current.organizationId,
          action: "CUSTOMER_ADDRESS_UPDATED",
          resourceType: "CustomerAddress",
          resourceId: id,
          metadata: { fields: Object.keys(input) },
        },
      });
      return updated;
    });
    return this.toAddress(row);
  }

  async deleteAddress(principal: AuthPrincipal, id: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "CustomerAddress" WHERE "id" = ${id} FOR UPDATE`;
      const current = await tx.customerAddress.findUnique({ where: { id } });
      if (!current) throw new NotFoundException("地址不存在");
      if (current.customerId !== principal.userId)
        throw new ForbiddenException("不能删除其他用户的地址");
      await tx.customerAddress.delete({ where: { id } });
      if (current.isDefault) {
        const replacement = await tx.customerAddress.findFirst({
          where: {
            organizationId: current.organizationId,
            customerId: principal.userId,
          },
          orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
          select: { id: true },
        });
        if (replacement) {
          await tx.customerAddress.update({
            where: { id: replacement.id },
            data: { isDefault: true },
          });
        }
      }
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId: current.organizationId,
          action: "CUSTOMER_ADDRESS_DELETED",
          resourceType: "CustomerAddress",
          resourceId: id,
          metadata: { wasDefault: current.isDefault },
        },
      });
      return { id, deleted: true };
    });
  }

  async createFeedback(
    principal: AuthPrincipal,
    input: CustomerFeedbackCreate,
  ): Promise<CustomerFeedback> {
    const organizationId = await this.resolveOrganizationId(
      principal.userId,
      input.organizationId,
    );
    const now = new Date();
    const { startsAt, endsAt } = this.shanghaiDayWindow(now);
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${principal.userId} FOR UPDATE`;
      const submittedToday = await tx.customerFeedback.count({
        where: {
          customerId: principal.userId,
          createdAt: { gte: startsAt, lt: endsAt },
        },
      });
      if (submittedToday >= 10) {
        throw new HttpException(
          "今日反馈提交次数已达上限，请明日再试",
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      const created = await tx.customerFeedback.create({
        data: {
          organizationId,
          customerId: principal.userId,
          category: input.category,
          contentEncrypted: this.crypto.encrypt(input.content),
          contactEncrypted: input.contact
            ? this.crypto.encrypt(input.contact)
            : null,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId,
          action: "CUSTOMER_FEEDBACK_CREATED",
          resourceType: "CustomerFeedback",
          resourceId: created.id,
          metadata: { category: created.category },
        },
      });
      return created;
    });
    return {
      id: row.id,
      organizationId: row.organizationId,
      category: row.category,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async accountDeletion(
    principal: AuthPrincipal,
    _requestedOrganizationId?: string,
  ): Promise<AccountDeletionRequest | null> {
    const row = await this.prisma.accountDeletionRequest.findFirst({
      where: { customerId: principal.userId },
      orderBy: { createdAt: "desc" },
    });
    return row ? this.toDeletionRequest(row) : null;
  }

  async requestAccountDeletion(
    principal: AuthPrincipal,
    input: AccountDeletionRequestCreate,
  ): Promise<AccountDeletionRequest> {
    const existingPending = await this.prisma.accountDeletionRequest.findFirst({
      where: {
        customerId: principal.userId,
        status: AccountDeletionRequestStatus.PENDING,
      },
      orderBy: { createdAt: "desc" },
    });
    if (existingPending) return this.toDeletionRequest(existingPending);
    const organizationId = await this.resolveOrganizationId(
      principal.userId,
      input.organizationId,
    );
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${principal.userId} FOR UPDATE`;
      const pending = await tx.accountDeletionRequest.findFirst({
        where: {
          customerId: principal.userId,
          status: AccountDeletionRequestStatus.PENDING,
        },
        orderBy: { createdAt: "desc" },
      });
      if (pending) return pending;
      const created = await tx.accountDeletionRequest.create({
        data: {
          organizationId,
          customerId: principal.userId,
          reasonEncrypted: input.reason
            ? this.crypto.encrypt(input.reason)
            : null,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId,
          action: "ACCOUNT_DELETION_REQUESTED",
          resourceType: "AccountDeletionRequest",
          resourceId: created.id,
          metadata: { hardDeletePerformed: false },
        },
      });
      return created;
    });
    return this.toDeletionRequest(row);
  }

  async adminConfig(
    principal: AuthPrincipal,
    organizationId: string,
  ): Promise<CustomerCenterContent> {
    this.access.assertPermission(
      principal,
      "customer-center.manage",
      organizationId,
    );
    await this.assertOrganization(organizationId);
    return this.readContent(organizationId);
  }

  async updateAdminConfig(
    principal: AuthPrincipal,
    organizationId: string,
    input: CustomerCenterConfigUpdate,
  ): Promise<CustomerCenterContent> {
    this.access.assertPermission(
      principal,
      "customer-center.manage",
      organizationId,
    );
    await this.assertOrganization(organizationId);
    const updated = await this.prisma.$transaction(async (tx) => {
      const config = await tx.customerCenterConfig.upsert({
        where: { organizationId },
        create: {
          organizationId,
          levelLabel: DEFAULT_CONTENT.levelLabel,
          customerServicePhone: DEFAULT_CONTENT.customerServicePhone,
          cityNewsTitle: DEFAULT_CONTENT.cityNewsTitle,
          cityNewsContent: DEFAULT_CONTENT.cityNewsContent,
          appBannerTitle: DEFAULT_CONTENT.appBannerTitle,
          appBannerSubtitle: DEFAULT_CONTENT.appBannerSubtitle,
          appDownloadUrl: DEFAULT_CONTENT.appDownloadUrl,
          safeguardItems: [...DEFAULT_CONTENT.safeguardItems],
          ...input,
        },
        update: input,
      });
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId,
          action: "CUSTOMER_CENTER_CONFIG_UPDATED",
          resourceType: "CustomerCenterConfig",
          resourceId: organizationId,
          metadata: { fields: Object.keys(input) },
        },
      });
      return config;
    });
    return this.toContent(updated);
  }

  async adminSummary(
    principal: AuthPrincipal,
    organizationId: string,
  ): Promise<AdminCustomerCenterSummary> {
    this.access.assertPermission(
      principal,
      "customer-center.manage",
      organizationId,
    );
    await this.assertOrganization(organizationId);
    const now = new Date();
    const [
      orders,
      couponAvailable,
      couponUsed,
      couponExpired,
      walletAggregate,
      transactionCount,
      feedbackOpen,
      feedbackTotal,
      deletionPending,
      deletionTotal,
    ] = await Promise.all([
      this.orderCounts({ organizationId }),
      this.prisma.customerCoupon.count({
        where: {
          organizationId,
          status: PrismaCustomerCouponStatus.AVAILABLE,
          validFrom: { lte: now },
          expiresAt: { gt: now },
        },
      }),
      this.prisma.customerCoupon.count({
        where: { organizationId, status: PrismaCustomerCouponStatus.USED },
      }),
      this.prisma.customerCoupon.count({
        where: {
          organizationId,
          OR: [
            { status: PrismaCustomerCouponStatus.EXPIRED },
            {
              status: PrismaCustomerCouponStatus.AVAILABLE,
              expiresAt: { lte: now },
            },
          ],
        },
      }),
      this.prisma.storedValueAccount.aggregate({
        where: { organizationId },
        _count: { id: true },
        _sum: { balanceFen: true },
      }),
      this.prisma.storedValueTransaction.count({
        where: { account: { organizationId } },
      }),
      this.prisma.customerFeedback.count({
        where: { organizationId, status: CustomerFeedbackStatus.OPEN },
      }),
      this.prisma.customerFeedback.count({ where: { organizationId } }),
      this.prisma.accountDeletionRequest.count({
        where: {
          organizationId,
          status: AccountDeletionRequestStatus.PENDING,
        },
      }),
      this.prisma.accountDeletionRequest.count({ where: { organizationId } }),
    ]);
    return {
      generatedAt: new Date().toISOString(),
      orders,
      coupons: {
        available: couponAvailable,
        used: couponUsed,
        expired: couponExpired,
      },
      wallet: {
        customerCount: walletAggregate._count.id,
        totalBalanceFen: this.safeMoney(walletAggregate._sum.balanceFen ?? 0n),
        transactionCount,
      },
      feedback: { open: feedbackOpen, total: feedbackTotal },
      accountDeletionRequests: {
        pending: deletionPending,
        total: deletionTotal,
      },
    };
  }

  private async resolveOrganizationId(
    customerId: string,
    requestedOrganizationId?: string,
  ) {
    if (requestedOrganizationId) {
      await this.assertOrganization(requestedOrganizationId);
      const [publishedService, priorOrder] = await Promise.all([
        this.prisma.service.findFirst({
          where: {
            organizationId: requestedOrganizationId,
            published: true,
          },
          select: { id: true },
        }),
        this.prisma.order.findFirst({
          where: {
            organizationId: requestedOrganizationId,
            customerId,
          },
          select: { id: true },
        }),
      ]);
      if (!publishedService && !priorOrder) {
        throw new ForbiddenException("该服务组织暂不可用于客户中心");
      }
      return requestedOrganizationId;
    }
    const latestOrder = await this.prisma.order.findFirst({
      where: { customerId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { organizationId: true },
    });
    if (latestOrder) return latestOrder.organizationId;
    const publishedService = await this.prisma.service.findFirst({
      where: { published: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { organizationId: true },
    });
    if (publishedService) return publishedService.organizationId;
    throw new NotFoundException("暂无可用服务组织");
  }

  private async assertOrganization(organizationId: string) {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true },
    });
    if (!organization) throw new NotFoundException("服务组织不存在");
  }

  private async readContent(
    organizationId: string,
  ): Promise<CustomerCenterContent> {
    const row = await this.prisma.customerCenterConfig.findUnique({
      where: { organizationId },
    });
    if (!row)
      return {
        ...DEFAULT_CONTENT,
        safeguardItems: [...DEFAULT_CONTENT.safeguardItems],
        updatedAt: null,
      };
    return this.toContent(row);
  }

  private toContent(row: {
    levelLabel: string;
    customerServicePhone: string | null;
    cityNewsTitle: string;
    cityNewsContent: string;
    appBannerTitle: string;
    appBannerSubtitle: string;
    appDownloadUrl: string | null;
    safeguardItems: Prisma.JsonValue;
    updatedAt: Date;
  }): CustomerCenterContent {
    const safeguardItems = Array.isArray(row.safeguardItems)
      ? row.safeguardItems.filter(
          (item): item is string => typeof item === "string",
        )
      : [];
    return {
      levelLabel: row.levelLabel,
      customerServicePhone: row.customerServicePhone,
      cityNewsTitle: row.cityNewsTitle,
      cityNewsContent: row.cityNewsContent,
      appBannerTitle: row.appBannerTitle,
      appBannerSubtitle: row.appBannerSubtitle,
      appDownloadUrl: row.appDownloadUrl,
      safeguardItems,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async orderCounts(filter: {
    organizationId: string;
    customerId?: string;
  }): Promise<CustomerCenterOrderCounts> {
    const base: Prisma.OrderWhereInput = {
      organizationId: filter.organizationId,
      ...(filter.customerId
        ? { customerId: filter.customerId, customerHiddenAt: null }
        : {}),
    };
    const [pendingPayment, inProgress, pendingReview, cancelled] =
      await Promise.all([
        this.prisma.order.count({
          where: { ...base, status: OrderStatus.PENDING_PAYMENT },
        }),
        this.prisma.order.count({
          where: { ...base, status: { in: IN_PROGRESS_STATUSES } },
        }),
        this.prisma.order.count({
          where: {
            ...base,
            status: OrderStatus.COMPLETED,
            technicianReview: { is: null },
          },
        }),
        this.prisma.order.count({
          where: {
            ...base,
            status: { in: [OrderStatus.CANCELLED, OrderStatus.REFUNDED] },
          },
        }),
      ]);
    return { pendingPayment, inProgress, pendingReview, cancelled };
  }

  private toDeletionRequest(row: {
    id: string;
    organizationId: string;
    status: AccountDeletionRequestStatus;
    createdAt: Date;
    updatedAt: Date;
    completedAt: Date | null;
  }): AccountDeletionRequest {
    return {
      id: row.id,
      organizationId: row.organizationId,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
    };
  }

  private toAddress(row: {
    id: string;
    organizationId: string;
    contactNameEncrypted: string;
    phoneEncrypted: string;
    detailEncrypted: string;
    latitude: number;
    longitude: number;
    coordinateSystem: string;
    isDefault: boolean;
    createdAt: Date;
    updatedAt: Date;
  }): CustomerAddress {
    if (row.coordinateSystem !== "GCJ-02") {
      throw new InternalServerErrorException("地址坐标系不受支持");
    }
    return {
      id: row.id,
      organizationId: row.organizationId,
      contactName: this.crypto.decrypt(row.contactNameEncrypted),
      phone: this.crypto.decrypt(row.phoneEncrypted),
      detail: this.crypto.decrypt(row.detailEncrypted),
      latitude: row.latitude,
      longitude: row.longitude,
      coordinateSystem: "GCJ-02",
      isDefault: row.isDefault,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private maskPhone(phone: string) {
    return /^1\d{10}$/.test(phone)
      ? `${phone.slice(0, 3)}****${phone.slice(-4)}`
      : null;
  }

  private shanghaiDayWindow(now: Date) {
    const offsetMs = 8 * 60 * 60 * 1_000;
    const local = new Date(now.getTime() + offsetMs);
    const startsAt = new Date(
      Date.UTC(
        local.getUTCFullYear(),
        local.getUTCMonth(),
        local.getUTCDate(),
      ) - offsetMs,
    );
    return { startsAt, endsAt: new Date(startsAt.getTime() + 86_400_000) };
  }

  private safeMoney(value: bigint) {
    const amount = Number(value);
    if (!Number.isSafeInteger(amount) || amount < 0)
      throw new InternalServerErrorException("金额超出安全序列化范围");
    return amount;
  }

  private safeSignedMoney(value: bigint) {
    const amount = Number(value);
    if (!Number.isSafeInteger(amount))
      throw new InternalServerErrorException("金额超出安全序列化范围");
    return amount;
  }
}
