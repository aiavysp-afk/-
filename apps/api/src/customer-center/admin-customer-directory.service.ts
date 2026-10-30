import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import {
  AdminCustomerDirectoryQuerySchema,
  AdminCustomerPhoneRevealRequestSchema,
  type AdminCustomerDirectory,
  type AdminCustomerDirectoryQuery,
  type AdminCustomerPhoneReveal,
  type AdminCustomerPhoneRevealRequest,
} from "@zydj/contracts";
import { AccessControlService } from "../auth/access-control.service.js";
import { AuthCryptoService } from "../auth/auth-crypto.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { PrismaService } from "../database/prisma.service.js";

const CUSTOMER_FIELDS = {
  id: true,
  displayName: true,
  phoneEncrypted: true,
  phoneVerifiedAt: true,
  createdAt: true,
} as const;

type CustomerRow = Prisma.UserGetPayload<{ select: typeof CUSTOMER_FIELDS }>;

@Injectable()
export class AdminCustomerDirectoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly crypto: AuthCryptoService,
  ) {}

  async list(
    principal: AuthPrincipal,
    organizationId: string,
    query: AdminCustomerDirectoryQuery,
  ): Promise<AdminCustomerDirectory> {
    this.assertAccess(principal, organizationId);
    const parsed = AdminCustomerDirectoryQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException("客户列表筛选参数无效");
    const { limit, cursor } = parsed.data;
    const rows = await this.prisma.user.findMany({
      where: {
        AND: [
          this.organizationCustomers(organizationId),
          ...(cursor ? [{ id: { gt: cursor } }] : []),
        ],
      },
      select: CUSTOMER_FIELDS,
      orderBy: { id: "asc" },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => {
        const phone = this.verifiedPhone(row);
        return {
          userId: row.id,
          displayName: row.displayName,
          maskedPhone: phone
            ? `${phone.slice(0, 3)}****${phone.slice(-4)}`
            : null,
          phoneVerified: phone !== null,
          createdAt: row.createdAt.toISOString(),
        };
      }),
      nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
    };
  }

  async revealPhone(
    principal: AuthPrincipal,
    organizationId: string,
    customerId: string,
    input: AdminCustomerPhoneRevealRequest,
  ): Promise<AdminCustomerPhoneReveal> {
    this.assertAccess(principal, organizationId);
    this.assertFreshMfa(principal);
    const parsed = AdminCustomerPhoneRevealRequestSchema.safeParse(input);
    if (!parsed.success || !/^[A-Za-z0-9_-]{1,128}$/.test(customerId))
      throw new BadRequestException("请填写 4 至 200 字的手机号查看用途");

    return this.prisma.$transaction(async (tx) => {
      // Reapply the complete organization predicate; a guessed ID, stale list,
      // cursor, role or client flag cannot become permission to reveal a phone.
      const row = await tx.user.findFirst({
        where: {
          AND: [this.organizationCustomers(organizationId), { id: customerId }],
        },
        select: CUSTOMER_FIELDS,
      });
      if (!row) throw new NotFoundException("客户不在当前组织的服务记录中");
      const phone = this.verifiedPhone(row);
      if (!phone) throw new NotFoundException("该客户暂无可查看的已验证手机号");
      this.assertFreshMfa(principal);
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId,
          action: "CUSTOMER_VERIFIED_PHONE_REVEALED",
          resourceType: "User",
          resourceId: row.id,
          // Free-form reasons may themselves contain PII. Keep a keyed digest,
          // not plaintext text, numbers, ciphertext, or the response payload.
          metadata: {
            purpose: "CUSTOMER_SERVICE_CONTACT",
            reasonProvided: true,
            reasonHash: this.crypto.hashPhoneVerification(
              "admin-customer-phone-reveal-reason",
              parsed.data.reason,
            ),
          },
        },
      });
      this.assertFreshMfa(principal);
      return {
        userId: row.id,
        phone,
        expiresAt: new Date(
          Math.min(Date.now() + 60_000, principal.mfaVerifiedUntil!.getTime()),
        ).toISOString(),
      };
    });
  }

  private assertAccess(principal: AuthPrincipal, organizationId: string) {
    if (
      principal.authChannel === "CUSTOMER_SMS" ||
      principal.authProvider === "customer-sms"
    )
      throw new ForbiddenException("客户登录不能查看后台客户资料");
    this.access.assertPermission(
      principal,
      "customer-center.manage",
      organizationId,
    );
  }

  private assertFreshMfa(principal: AuthPrincipal) {
    if (
      !principal.mfaVerifiedUntil ||
      !Number.isFinite(principal.mfaVerifiedUntil.getTime()) ||
      principal.mfaVerifiedUntil.getTime() <= Date.now()
    )
      throw new ForbiddenException(
        "查看完整手机号需要先在账户安全完成动态码验证",
      );
  }

  private organizationCustomers(organizationId: string): Prisma.UserWhereInput {
    return {
      status: "ACTIVE",
      OR: [
        // New customer registrations record their trusted server-selected site
        // organization; no order or coupon is required to appear in that site's list.
        {
          organizationId,
          role: "CUSTOMER",
          phoneVerifiedAt: { not: null },
          customerPhoneIdentity: { isNot: null },
        },
        { customerOrders: { some: { organizationId } } },
        { customerReservations: { some: { organizationId } } },
        { storedValueAccounts: { some: { organizationId } } },
        { customerCoupons: { some: { organizationId } } },
        { customerAddresses: { some: { organizationId } } },
        { customerFeedbacks: { some: { organizationId } } },
        { accountDeletionRequests: { some: { organizationId } } },
      ],
    };
  }

  private verifiedPhone(row: CustomerRow): string | null {
    if (!row.phoneEncrypted || !row.phoneVerifiedAt) return null;
    try {
      const phone = this.crypto.decrypt(row.phoneEncrypted);
      return /^1[3-9]\d{9}$/.test(phone) ? phone : null;
    } catch {
      // Do not expose decryption errors, ciphertext or malformed legacy PII.
      return null;
    }
  }
}
