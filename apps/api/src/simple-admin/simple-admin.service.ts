import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import {
  SimpleAdminOrdersQuerySchema,
  SimpleAdminTechniciansQuerySchema,
  type AdminCustomerDirectoryQuery,
  type SimpleAdminOrderDetail,
  type SimpleAdminOrders,
  type SimpleAdminOrdersQuery,
  type SimpleAdminTechnicians,
  type SimpleAdminTechniciansQuery,
} from "@zydj/contracts";
import { AccessControlService } from "../auth/access-control.service.js";
import { AuthCryptoService } from "../auth/auth-crypto.service.js";
import type { AuthPrincipal, Permission } from "../auth/auth.types.js";
import { AdminCustomerDirectoryService } from "../customer-center/admin-customer-directory.service.js";
import { PrismaService } from "../database/prisma.service.js";

@Injectable()
export class SimpleAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly crypto: AuthCryptoService,
    private readonly customers: AdminCustomerDirectoryService,
  ) {}

  async technicians(
    principal: AuthPrincipal,
    organizationId: string,
    input: SimpleAdminTechniciansQuery,
  ): Promise<SimpleAdminTechnicians> {
    this.assertAccess(principal, "technicians.manage", organizationId);
    const parsed = SimpleAdminTechniciansQuerySchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("技师筛选参数无效");
    const { limit, cursor, status } = parsed.data;
    const rows = await this.prisma.technicianProfile.findMany({
      where: {
        organizationId,
        registrationChannel: { not: "ADMIN_PHOTO_DRAFT" },
        technician: { status: "ACTIVE" },
        ...(status === "ALL" ? {} : { status }),
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      select: {
        id: true,
        technicianId: true,
        publicName: true,
        realNameEncrypted: true,
        status: true,
        version: true,
        technician: {
          select: {
            displayName: true,
            phoneEncrypted: true,
            phoneVerifiedAt: true,
          },
        },
      },
      orderBy: { id: "asc" },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => {
        let name = row.publicName || row.technician.displayName;
        if (row.realNameEncrypted) {
          try {
            name = this.crypto.decryptScoped(
              `technician-real-name:${row.id}`,
              row.realNameEncrypted,
            );
          } catch {
            // An unreadable private field never leaks its ciphertext or errors.
          }
        }
        return {
          technicianId: row.technicianId,
          name,
          maskedPhone: this.maskedPhone(row.technician),
          status: row.status,
          version: row.version,
          certificatePhotos: [],
          certificatePhotoStatus: "NOT_UPLOADED" as const,
        };
      }),
      nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
    };
  }

  async orders(
    principal: AuthPrincipal,
    organizationId: string,
    input: SimpleAdminOrdersQuery,
  ): Promise<SimpleAdminOrders> {
    this.assertAccess(principal, "orders.read", organizationId);
    const parsed = SimpleAdminOrdersQuerySchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("订单筛选参数无效");
    const { limit, cursor, status } = parsed.data;
    const rows = await this.prisma.order.findMany({
      where: {
        organizationId,
        ...(status === "ALL" ? {} : { status }),
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      select: {
        id: true,
        orderNo: true,
        appointmentStart: true,
        status: true,
        customer: { select: { displayName: true } },
      },
      orderBy: { id: "asc" },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => ({
        id: row.id,
        orderNo: row.orderNo,
        customerNickname: row.customer.displayName,
        appointmentStart: row.appointmentStart.toISOString(),
        status: row.status,
      })),
      nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
    };
  }

  async orderDetail(
    principal: AuthPrincipal,
    organizationId: string,
    orderId: string,
  ): Promise<SimpleAdminOrderDetail> {
    this.assertAccess(principal, "orders.read", organizationId);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(orderId))
      throw new BadRequestException("订单编号无效");
    const row = await this.prisma.order.findFirst({
      where: { id: orderId, organizationId },
      select: {
        id: true,
        orderNo: true,
        appointmentStart: true,
        appointmentEnd: true,
        status: true,
        createdAt: true,
        serviceAmountFen: true,
        travelFeeFen: true,
        discountFen: true,
        payableFen: true,
        customer: { select: { displayName: true } },
        therapist: {
          select: {
            displayName: true,
            technicianProfile: { select: { publicName: true } },
          },
        },
        items: {
          select: {
            serviceName: true,
            durationMinutes: true,
            unitPriceFen: true,
            quantity: true,
          },
          orderBy: { id: "asc" },
        },
      },
    });
    if (!row) throw new NotFoundException("订单不在当前组织中");
    return {
      id: row.id,
      orderNo: row.orderNo,
      customerNickname: row.customer.displayName,
      appointmentStart: row.appointmentStart.toISOString(),
      appointmentEnd: row.appointmentEnd.toISOString(),
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      serviceAmountFen: this.money(row.serviceAmountFen),
      travelFeeFen: this.money(row.travelFeeFen),
      discountFen: this.money(row.discountFen),
      payableFen: this.money(row.payableFen),
      technicianName: row.therapist
        ? row.therapist.technicianProfile?.publicName ||
          row.therapist.displayName
        : null,
      items: row.items.map((item) => ({
        ...item,
        unitPriceFen: this.money(item.unitPriceFen),
      })),
    };
  }

  users(
    principal: AuthPrincipal,
    organizationId: string,
    query: AdminCustomerDirectoryQuery,
  ) {
    this.assertAccess(principal, "customer-center.manage", organizationId);
    return this.customers.list(principal, organizationId, query);
  }

  private assertAccess(
    principal: AuthPrincipal,
    permission: Permission,
    organizationId: string,
  ) {
    // THERAPIST has orders.read for their own workbench. It must not become
    // permission to browse every customer order in the organization here.
    const managementRoles = new Set([
      "ADMIN",
      "OPERATOR",
      "DISPATCHER",
      "FINANCE_REQUESTER",
      "FINANCE_APPROVER",
      "SAFETY_DUTY",
    ]);
    if (
      !principal.memberships.some(
        (membership) =>
          membership.organizationId === organizationId &&
          managementRoles.has(membership.role),
      ) ||
      ["CUSTOMER_SMS", "TECHNICIAN_PHONE"].includes(
        principal.authChannel ?? "",
      ) ||
      ["customer-sms", "technician-sms"].includes(principal.authProvider ?? "")
    )
      throw new ForbiddenException("请使用已授权的后台管理账号登录");
    this.access.assertPermission(principal, permission, organizationId);
  }

  private maskedPhone(user: {
    phoneEncrypted: string | null;
    phoneVerifiedAt: Date | null;
  }) {
    if (!user.phoneEncrypted || !user.phoneVerifiedAt) return null;
    try {
      const phone = this.crypto.decrypt(user.phoneEncrypted);
      return /^1[3-9]\d{9}$/.test(phone)
        ? `${phone.slice(0, 3)}****${phone.slice(-4)}`
        : null;
    } catch {
      return null;
    }
  }

  private money(fen: bigint) {
    const amount = Number(fen);
    if (!Number.isSafeInteger(amount) || amount < 0)
      throw new InternalServerErrorException("订单金额无法安全读取");
    return amount;
  }
}
