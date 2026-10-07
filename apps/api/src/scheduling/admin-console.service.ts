import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  MembershipStatus,
  OrderStatus,
  ShiftStatus,
  UserRole,
} from "@prisma/client";
import type {
  AdminReadiness,
  AdminServiceArea,
  AdminTechnicianBoard,
} from "@zydj/contracts";
import { AccessControlService } from "../auth/access-control.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import type { AppEnv } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";

const ZHENGZHOU_FULL_ADCODE_LIST = [
  "410102",
  "410103",
  "410104",
  "410105",
  "410106",
  "410108",
  "410122",
  "410171",
  "410172",
  "410173",
  "410181",
  "410182",
  "410183",
  "410184",
  "410185",
] as const;

const ACTIVE_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.PAID,
  OrderStatus.DISPATCHING,
  OrderStatus.ASSIGNED,
  OrderStatus.EN_ROUTE,
  OrderStatus.ARRIVED,
  OrderStatus.IN_SERVICE,
  OrderStatus.AWAITING_CONFIRMATION,
];

@Injectable()
export class AdminConsoleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  async technicians(
    principal: AuthPrincipal,
    organizationId: string,
    now = new Date(),
  ): Promise<AdminTechnicianBoard> {
    this.access.assertPermission(principal, "schedule.read", organizationId);
    const { start, end, day } = this.shanghaiDay(now);
    const memberships = await this.prisma.staffMembership.findMany({
      where: {
        organizationId,
        role: UserRole.THERAPIST,
        status: MembershipStatus.ACTIVE,
      },
      select: {
        user: {
          select: {
            id: true,
            displayName: true,
            status: true,
            therapistShifts: {
              where: {
                organizationId,
                startsAt: { lt: end },
                endsAt: { gt: start },
              },
              select: {
                id: true,
                startsAt: true,
                endsAt: true,
                status: true,
              },
              orderBy: { startsAt: "asc" },
            },
            therapistOrders: {
              where: {
                organizationId,
                appointmentStart: { gte: start, lt: end },
              },
              select: { status: true },
            },
          },
        },
      },
      orderBy: { user: { displayName: "asc" } },
    });

    return {
      day,
      timeZone: "Asia/Shanghai",
      generatedAt: now.toISOString(),
      technicians: memberships.map(({ user }) => {
        const activeShifts = user.therapistShifts.filter(
          (shift) => shift.status === ShiftStatus.ACTIVE,
        );
        const currentShift = activeShifts.find(
          (shift) => shift.startsAt <= now && shift.endsAt > now,
        );
        const shift = currentShift ?? activeShifts[0] ?? null;
        return {
          id: user.id,
          displayName: user.displayName,
          accountStatus: user.status,
          availability: currentShift
            ? ("ON_SHIFT" as const)
            : shift
              ? ("SCHEDULED" as const)
              : ("OFF_DUTY" as const),
          todayShift: shift
            ? {
                id: shift.id,
                startsAt: shift.startsAt.toISOString(),
                endsAt: shift.endsAt.toISOString(),
                status: shift.status,
              }
            : null,
          metrics: {
            activeOrders: user.therapistOrders.filter((order) =>
              ACTIVE_ORDER_STATUSES.includes(order.status),
            ).length,
            completedToday: user.therapistOrders.filter(
              (order) => order.status === OrderStatus.COMPLETED,
            ).length,
          },
        };
      }),
    };
  }

  serviceArea(
    principal: AuthPrincipal,
    organizationId: string,
  ): AdminServiceArea {
    this.access.assertPermission(principal, "orders.read", organizationId);
    const configuredAdcodes = this.config
      .get("SERVICE_AREA_ADCODE_ALLOWLIST", { infer: true })
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const fullyConfigured = ZHENGZHOU_FULL_ADCODE_LIST.every((adcode) =>
      configuredAdcodes.includes(adcode),
    );
    return {
      serviceCity: this.config.get("SERVICE_CITY", { infer: true }),
      coveragePolicy: "ZHENGZHOU_FULL",
      targetAdcodes: [...ZHENGZHOU_FULL_ADCODE_LIST],
      configuredAdcodes,
      fullyConfigured,
      mapProvider: this.config.get("MAP_PROVIDER", { infer: true }),
      verificationEnabled:
        this.config.get("MAP_PROVIDER", { infer: true }) === "tencent" &&
        this.config.get("MAP_GEOCODING_ENABLED", { infer: true }) === "true",
      notice:
        "业务目标为郑州全域；地图地址核验只有在腾讯地图凭据、签名密钥和门禁全部配置后才会启用。",
    };
  }

  readiness(principal: AuthPrincipal, organizationId: string): AdminReadiness {
    this.access.assertPermission(principal, "audit.read", organizationId);
    const configuredAdcodes = this.config
      .get("SERVICE_AREA_ADCODE_ALLOWLIST", { infer: true })
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    return {
      environment: this.config.get("NODE_ENV", { infer: true }),
      generatedAt: new Date().toISOString(),
      auth: {
        provider: this.config.get("AUTH_PROVIDER", { infer: true }),
        staffMfaRequired:
          this.config.get("STAFF_MFA_REQUIRED", { infer: true }) === "true",
        browserLoginEnabled:
          this.config.get("STAFF_BROWSER_LOGIN_ENABLED", { infer: true }) ===
          "true",
      },
      payment: {
        provider: this.config.get("PAYMENT_PROVIDER", { infer: true }),
        prepayEnabled:
          this.config.get("WECHAT_PAY_PREPAY_ENABLED", { infer: true }) ===
          "true",
        recoveryEnabled:
          this.config.get("WECHAT_PAY_RECOVERY_ENABLED", { infer: true }) ===
          "true",
        refundEnabled:
          this.config.get("WECHAT_PAY_REFUND_ENABLED", { infer: true }) ===
          "true",
      },
      map: {
        provider: this.config.get("MAP_PROVIDER", { infer: true }),
        geocodingEnabled:
          this.config.get("MAP_GEOCODING_ENABLED", { infer: true }) === "true",
        coverageConfigured: ZHENGZHOU_FULL_ADCODE_LIST.every((adcode) =>
          configuredAdcodes.includes(adcode),
        ),
      },
      safety: {
        smsProvider: this.config.get("SMS_PROVIDER", { infer: true }),
        smsSendEnabled:
          this.config.get("SMS_SEND_ENABLED", { infer: true }) === "true",
        dispatchEnabled:
          this.config.get("SAFETY_NOTIFICATION_DISPATCH_ENABLED", {
            infer: true,
          }) === "true",
        receiptQueryEnabled:
          this.config.get("SAFETY_NOTIFICATION_RECEIPT_QUERY_ENABLED", {
            infer: true,
          }) === "true",
        dutyConfirmed:
          this.config.get("SAFETY_DUTY_CONFIRMED", { infer: true }) === "true",
      },
      customerService: {
        provider: this.config.get("CUSTOMER_SERVICE_PROVIDER", { infer: true }),
        ownershipConfirmed:
          this.config.get("WECOM_CUSTOMER_SERVICE_CONFIRMED", {
            infer: true,
          }) === "true",
      },
    };
  }

  private shanghaiDay(now: Date) {
    const offsetMs = 8 * 60 * 60 * 1_000;
    const local = new Date(now.getTime() + offsetMs);
    const start = new Date(
      Date.UTC(
        local.getUTCFullYear(),
        local.getUTCMonth(),
        local.getUTCDate(),
      ) - offsetMs,
    );
    return {
      start,
      end: new Date(start.getTime() + 24 * 60 * 60 * 1_000),
      day: local.toISOString().slice(0, 10),
    };
  }
}
