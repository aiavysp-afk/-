import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { CustomerCouponStatus, type CustomerCoupon } from "@prisma/client";
import type { NewcomerCouponOffer } from "@zydj/contracts";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { PrismaService } from "../database/prisma.service.js";

export const NEWCOMER_COUPONS = [
  { sourceCode: "WELCOME_V1_40", amountFen: 4_000n, minimumSpendFen: 49_800n },
  { sourceCode: "WELCOME_V1_30", amountFen: 3_000n, minimumSpendFen: 39_800n },
  { sourceCode: "WELCOME_V1_20", amountFen: 2_000n, minimumSpendFen: 29_800n },
  { sourceCode: "WELCOME_V1_10", amountFen: 1_000n, minimumSpendFen: 19_800n },
] as const;
export const NEWCOMER_COUPON_VALIDITY_DAYS = 90;
const SOURCE_CODES = NEWCOMER_COUPONS.map((coupon) => coupon.sourceCode);

@Injectable()
export class CustomerCouponsService {
  constructor(private readonly prisma: PrismaService) {}

  async newcomerOffer(
    principal: AuthPrincipal,
    requestedOrganizationId?: string,
    now = new Date(),
  ): Promise<NewcomerCouponOffer> {
    const organizationId = await this.resolveOrganization(
      principal.userId,
      requestedOrganizationId,
    );
    const [user, coupons] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: principal.userId },
        select: { status: true, phoneEncrypted: true, phoneVerifiedAt: true },
      }),
      this.prisma.customerCoupon.findMany({
        where: {
          organizationId,
          customerId: principal.userId,
          sourceCode: { in: SOURCE_CODES },
        },
        orderBy: [{ amountFen: "desc" }, { id: "asc" }],
      }),
    ]);
    const verified = !!(
      user?.status === "ACTIVE" &&
      user.phoneEncrypted &&
      user.phoneVerifiedAt
    );
    return this.toOffer(organizationId, verified, coupons, now);
  }

  async claimNewcomerCoupons(
    principal: AuthPrincipal,
    requestedOrganizationId?: string,
    now = new Date(),
  ): Promise<NewcomerCouponOffer & { idempotentReplay: boolean }> {
    const organizationId = await this.resolveOrganization(
      principal.userId,
      requestedOrganizationId,
    );
    return this.prisma.$transaction(async (tx) => {
      // Serialize manual claims for this customer. Reading an offer never grants assets.
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${principal.userId} FOR UPDATE`;
      const user = await tx.user.findUnique({
        where: { id: principal.userId },
        select: { status: true, phoneEncrypted: true, phoneVerifiedAt: true },
      });
      if (
        user?.status !== "ACTIVE" ||
        !user.phoneEncrypted ||
        !user.phoneVerifiedAt
      ) {
        throw new ForbiddenException("请先完成手机号验证后领取优惠券");
      }
      const existing = await tx.customerCoupon.findMany({
        where: {
          organizationId,
          customerId: principal.userId,
          sourceCode: { in: SOURCE_CODES },
        },
        orderBy: [{ amountFen: "desc" }, { id: "asc" }],
      });
      if (existing.length) {
        return {
          ...this.toOffer(organizationId, true, existing, now),
          idempotentReplay: true,
        };
      }
      const expiresAt = new Date(
        now.getTime() + NEWCOMER_COUPON_VALIDITY_DAYS * 86_400_000,
      );
      const coupons: CustomerCoupon[] = [];
      for (const definition of NEWCOMER_COUPONS) {
        coupons.push(
          await tx.customerCoupon.create({
            data: {
              organizationId,
              customerId: principal.userId,
              ...definition,
              title: `${Number(definition.amountFen) / 100}元新人优惠券`,
              applicability: `仅项目费满${Number(definition.minimumSpendFen) / 100}元可使用`,
              canApplyToTravelFee: false,
              validFrom: now,
              expiresAt,
            },
          }),
        );
      }
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId,
          action: "NEWCOMER_COUPONS_CLAIMED",
          resourceType: "CustomerCoupon",
          resourceId: principal.userId,
          metadata: { sourceCodes: SOURCE_CODES, couponIds: coupons.map((row) => row.id) },
        },
      });
      return {
        ...this.toOffer(organizationId, true, coupons, now),
        idempotentReplay: false,
      };
    });
  }

  private toOffer(
    organizationId: string,
    verified: boolean,
    coupons: CustomerCoupon[],
    now: Date,
  ): NewcomerCouponOffer {
    const claimed = coupons.length > 0;
    return {
      organizationId,
      eligible: verified && !claimed,
      claimed,
      reason: claimed
        ? "新人优惠券已领取"
        : verified
          ? "领取后90天内有效，仅抵扣服务项目费"
          : "完成手机号验证后领取新人优惠券",
      coupons: coupons.map((row) => ({
        id: row.id,
        organizationId: row.organizationId,
        title: row.title,
        amountFen: Number(row.amountFen),
        minimumSpendFen: Number(row.minimumSpendFen),
        applicability: row.applicability,
        canApplyToTravelFee: row.canApplyToTravelFee,
        validFrom: row.validFrom.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        status:
          row.status === CustomerCouponStatus.AVAILABLE && row.expiresAt <= now
            ? "EXPIRED"
            : row.status,
        usedAt: row.usedAt?.toISOString() ?? null,
      })),
    };
  }

  private async resolveOrganization(customerId: string, requested?: string) {
    if (requested) {
      const organization = await this.prisma.organization.findUnique({
        where: { id: requested },
        select: { id: true },
      });
      if (!organization) throw new NotFoundException("服务组织不存在");
      const [published, previous] = await Promise.all([
        this.prisma.service.findFirst({
          where: { organizationId: requested, published: true },
          select: { id: true },
        }),
        this.prisma.order.findFirst({
          where: { organizationId: requested, customerId },
          select: { id: true },
        }),
      ]);
      if (!published && !previous) {
        throw new ForbiddenException("该服务组织暂不可用于客户中心");
      }
      return requested;
    }
    const previous = await this.prisma.order.findFirst({
      where: { customerId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { organizationId: true },
    });
    if (previous) return previous.organizationId;
    const service = await this.prisma.service.findFirst({
      where: { published: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { organizationId: true },
    });
    if (service) return service.organizationId;
    throw new NotFoundException("暂无可用服务组织");
  }
}
