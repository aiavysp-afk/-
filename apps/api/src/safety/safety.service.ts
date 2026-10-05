import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  MembershipStatus,
  OrderStatus,
  Prisma,
  SafetyIncidentStatus,
  UserRole,
  type SafetyIncident,
} from "@prisma/client";
import type {
  SafetyDutyRosterUpsert,
  SafetyIncidentClose,
  SafetyIncidentCreate,
  SafetyIncidentCustomerView,
  SafetyIncidentView,
} from "@zydj/contracts";
import { createHash } from "node:crypto";
import { AccessControlService } from "../auth/access-control.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { PrismaService } from "../database/prisma.service.js";

const INCIDENT_ORDER_STATUSES = new Set<OrderStatus>([
  OrderStatus.PAID,
  OrderStatus.DISPATCHING,
  OrderStatus.ASSIGNED,
  OrderStatus.EN_ROUTE,
  OrderStatus.ARRIVED,
  OrderStatus.IN_SERVICE,
  OrderStatus.AWAITING_CONFIRMATION,
]);

@Injectable()
export class SafetyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
  ) {}

  async configureRoster(
    principal: AuthPrincipal,
    organizationId: string,
    input: SafetyDutyRosterUpsert,
  ) {
    this.access.assertPermission(principal, "iam.manage", organizationId);
    if (input.primaryUserId === input.backupUserId)
      throw new BadRequestException("主备值班人员必须是不同自然人");

    return this.prisma.$transaction(async (tx) => {
      const organization = await tx.organization.findUnique({
        where: { id: organizationId },
        select: { id: true },
      });
      if (!organization) throw new NotFoundException("组织不存在");
      await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${organizationId} FOR UPDATE`;
      const memberships = await tx.staffMembership.findMany({
        where: {
          organizationId,
          userId: { in: [input.primaryUserId, input.backupUserId] },
          role: UserRole.SAFETY_DUTY,
          status: MembershipStatus.ACTIVE,
        },
        select: { userId: true },
      });
      const activeIds = new Set(memberships.map((item) => item.userId));
      if (
        !activeIds.has(input.primaryUserId) ||
        !activeIds.has(input.backupUserId)
      )
        throw new BadRequestException(
          "主备人员必须具有当前组织的有效安全值班身份",
        );
      const now = new Date();
      await tx.safetyDutyRoster.updateMany({
        where: { organizationId, active: true },
        data: { active: false, deactivatedAt: now },
      });
      const roster = await tx.safetyDutyRoster.create({
        data: {
          organizationId,
          primaryUserId: input.primaryUserId,
          backupUserId: input.backupUserId,
          acknowledgementTimeoutSeconds: input.acknowledgementTimeoutSeconds,
          createdById: principal.userId,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId,
          action: "SAFETY_DUTY_ROSTER_CONFIGURED",
          resourceType: "SafetyDutyRoster",
          resourceId: roster.id,
          metadata: {
            primaryUserId: roster.primaryUserId,
            backupUserId: roster.backupUserId,
            acknowledgementTimeoutSeconds: roster.acknowledgementTimeoutSeconds,
          },
        },
      });
      return this.toRosterView(roster);
    });
  }

  async getActiveRoster(principal: AuthPrincipal, organizationId: string) {
    this.access.assertPermission(principal, "safety.respond", organizationId);
    const roster = await this.prisma.safetyDutyRoster.findFirst({
      where: { organizationId, active: true },
      orderBy: { createdAt: "desc" },
    });
    return roster ? this.toRosterView(roster) : null;
  }

  async listEligibleResponders(
    principal: AuthPrincipal,
    organizationId: string,
  ) {
    this.access.assertPermission(principal, "iam.manage", organizationId);
    const memberships = await this.prisma.staffMembership.findMany({
      where: {
        organizationId,
        role: UserRole.SAFETY_DUTY,
        status: MembershipStatus.ACTIVE,
        user: { status: "ACTIVE" },
      },
      select: {
        userId: true,
        user: { select: { displayName: true, phoneEncrypted: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    return memberships.map((membership) => ({
      userId: membership.userId,
      displayName: membership.user.displayName,
      phoneConfigured: Boolean(membership.user.phoneEncrypted),
    }));
  }

  async createIncident(
    principal: AuthPrincipal,
    orderId: string,
    input: SafetyIncidentCreate,
    idempotencyKey: string,
  ) {
    const requestFingerprint = this.fingerprint({ orderId, ...input });
    const existing = await this.findByIdempotency(
      principal.userId,
      idempotencyKey,
    );
    if (existing) return this.replay(existing, requestFingerprint);

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        customerId: true,
        organizationId: true,
        status: true,
      },
    });
    if (!order) throw new NotFoundException("订单不存在");
    if (order.customerId !== principal.userId)
      throw new ForbiddenException("不能为其他用户的订单发起安全事件");
    if (!INCIDENT_ORDER_STATUSES.has(order.status))
      throw new ConflictException("当前订单阶段不能发起服务安全事件");

    const roster = await this.prisma.safetyDutyRoster.findFirst({
      where: { organizationId: order.organizationId, active: true },
      orderBy: { createdAt: "desc" },
    });
    if (!roster)
      throw new ServiceUnavailableException(
        "安全值班主备岗未配置，请立即拨打商家值班电话或公共应急服务",
      );

    try {
      const incident = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
        const lockedOrder = await tx.order.findUnique({
          where: { id: orderId },
          select: {
            id: true,
            customerId: true,
            organizationId: true,
            status: true,
          },
        });
        if (!lockedOrder) throw new NotFoundException("订单不存在");
        if (lockedOrder.customerId !== principal.userId)
          throw new ForbiddenException("不能为其他用户的订单发起安全事件");
        if (!INCIDENT_ORDER_STATUSES.has(lockedOrder.status))
          throw new ConflictException("当前订单阶段不能发起服务安全事件");
        const unresolved = await tx.safetyIncident.findFirst({
          where: {
            orderId,
            status: {
              in: [
                SafetyIncidentStatus.OPEN,
                SafetyIncidentStatus.ESCALATED,
                SafetyIncidentStatus.ACKNOWLEDGED,
              ],
            },
          },
          select: { id: true },
        });
        if (unresolved)
          throw new ConflictException("该订单已有待处理的安全事件");
        const activeRoster = await tx.safetyDutyRoster.findFirst({
          where: {
            id: roster.id,
            organizationId: lockedOrder.organizationId,
            active: true,
          },
        });
        if (!activeRoster)
          throw new ConflictException("安全值班表已变化，请重新提交");
        const now = new Date();
        const record = await tx.safetyIncident.create({
          data: {
            organizationId: lockedOrder.organizationId,
            orderId,
            reporterUserId: principal.userId,
            rosterId: activeRoster.id,
            primaryUserId: activeRoster.primaryUserId,
            backupUserId: activeRoster.backupUserId,
            category: input.category,
            idempotencyKey,
            requestFingerprint,
            acknowledgementDueAt: new Date(
              now.getTime() +
                activeRoster.acknowledgementTimeoutSeconds * 1_000,
            ),
            events: {
              create: {
                type: "SAFETY_INCIDENT_OPENED",
                actorId: principal.userId,
                payload: { category: input.category },
              },
            },
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: principal.userId,
            organizationId: lockedOrder.organizationId,
            action: "SAFETY_INCIDENT_OPENED",
            resourceType: "SafetyIncident",
            resourceId: record.id,
            metadata: { orderId, category: input.category },
          },
        });
        await tx.outboxEvent.create({
          data: {
            organizationId: lockedOrder.organizationId,
            aggregateId: record.id,
            type: "SAFETY_INCIDENT_OPENED",
            payload: {
              incidentId: record.id,
              organizationId: lockedOrder.organizationId,
              primaryUserId: record.primaryUserId,
              acknowledgementDueAt: record.acknowledgementDueAt,
            },
          },
        });
        return record;
      });
      return { data: this.toCustomerView(incident), idempotentReplay: false };
    } catch (error) {
      const replay = await this.findByIdempotency(
        principal.userId,
        idempotencyKey,
      );
      if (replay) return this.replay(replay, requestFingerprint);
      throw error;
    }
  }

  async listOwn(principal: AuthPrincipal, orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { customerId: true },
    });
    if (!order) throw new NotFoundException("订单不存在");
    if (order.customerId !== principal.userId)
      throw new ForbiddenException("不能查看其他用户的安全事件");
    const rows = await this.prisma.safetyIncident.findMany({
      where: { orderId, reporterUserId: principal.userId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return rows.map((row) => this.toCustomerView(row));
  }

  async listStaff(principal: AuthPrincipal, organizationId: string) {
    this.access.assertPermission(principal, "safety.respond", organizationId);
    const rows = await this.prisma.safetyIncident.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return rows.map((row) => this.toView(row));
  }

  async acknowledge(
    principal: AuthPrincipal,
    organizationId: string,
    incidentId: string,
    now = new Date(),
  ) {
    this.access.assertPermission(principal, "safety.respond", organizationId);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "SafetyIncident" WHERE "id" = ${incidentId} FOR UPDATE`;
      let incident = await tx.safetyIncident.findUnique({
        where: { id: incidentId },
      });
      if (!incident || incident.organizationId !== organizationId)
        throw new NotFoundException("安全事件不存在");
      if (incident.status === SafetyIncidentStatus.CLOSED)
        throw new ConflictException("安全事件已经关闭");
      if (incident.status === SafetyIncidentStatus.ACKNOWLEDGED) {
        if (incident.acknowledgedById !== principal.userId)
          throw new ConflictException("安全事件已由其他值班人员确认");
        return this.toView(incident);
      }

      if (
        incident.status === SafetyIncidentStatus.OPEN &&
        incident.acknowledgementDueAt.getTime() <= now.getTime()
      ) {
        await this.escalateLocked(tx, incident, now);
        incident = await tx.safetyIncident.findUniqueOrThrow({
          where: { id: incidentId },
        });
      }
      const expectedUserId =
        incident.status === SafetyIncidentStatus.OPEN
          ? incident.primaryUserId
          : incident.backupUserId;
      if (principal.userId !== expectedUserId)
        throw new ForbiddenException(
          incident.status === SafetyIncidentStatus.OPEN
            ? "主岗确认时限内仅主岗可确认"
            : "事件已升级，仅备岗可确认",
        );

      const updated = await tx.safetyIncident.updateMany({
        where: {
          id: incident.id,
          status: incident.status,
          acknowledgedById: null,
        },
        data: {
          status: SafetyIncidentStatus.ACKNOWLEDGED,
          acknowledgedById: principal.userId,
          acknowledgedAt: now,
        },
      });
      if (updated.count !== 1)
        throw new ConflictException("安全事件状态已变化");
      await tx.safetyIncidentEvent.create({
        data: {
          incidentId: incident.id,
          type: "SAFETY_INCIDENT_ACKNOWLEDGED",
          actorId: principal.userId,
          payload: { fromStatus: incident.status },
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId,
          action: "SAFETY_INCIDENT_ACKNOWLEDGED",
          resourceType: "SafetyIncident",
          resourceId: incident.id,
          metadata: { fromStatus: incident.status },
        },
      });
      await tx.outboxEvent.create({
        data: {
          organizationId,
          aggregateId: incident.id,
          type: "SAFETY_INCIDENT_ACKNOWLEDGED",
          payload: {
            incidentId: incident.id,
            acknowledgedById: principal.userId,
          },
        },
      });
      return this.toView(
        await tx.safetyIncident.findUniqueOrThrow({
          where: { id: incident.id },
        }),
      );
    });
  }

  async close(
    principal: AuthPrincipal,
    organizationId: string,
    incidentId: string,
    input: SafetyIncidentClose,
    now = new Date(),
  ) {
    this.access.assertPermission(principal, "safety.respond", organizationId);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "SafetyIncident" WHERE "id" = ${incidentId} FOR UPDATE`;
      const incident = await tx.safetyIncident.findUnique({
        where: { id: incidentId },
      });
      if (!incident || incident.organizationId !== organizationId)
        throw new NotFoundException("安全事件不存在");
      if (incident.status === SafetyIncidentStatus.CLOSED) {
        if (incident.closedById !== principal.userId)
          throw new ForbiddenException(
            "只能由关闭该事件的值班人员重复确认结果",
          );
        return this.toView(incident);
      }
      if (incident.status !== SafetyIncidentStatus.ACKNOWLEDGED)
        throw new ConflictException("安全事件必须先由值班人员确认");
      if (incident.acknowledgedById !== principal.userId)
        throw new ForbiddenException("只能由已确认该事件的值班人员关闭");

      await tx.safetyIncident.update({
        where: { id: incident.id },
        data: {
          status: SafetyIncidentStatus.CLOSED,
          closedById: principal.userId,
          resolutionCode: input.resolutionCode,
          closedAt: now,
        },
      });
      await tx.safetyIncidentEvent.create({
        data: {
          incidentId: incident.id,
          type: "SAFETY_INCIDENT_CLOSED",
          actorId: principal.userId,
          payload: { resolutionCode: input.resolutionCode },
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId,
          action: "SAFETY_INCIDENT_CLOSED",
          resourceType: "SafetyIncident",
          resourceId: incident.id,
          metadata: { resolutionCode: input.resolutionCode },
        },
      });
      await tx.outboxEvent.create({
        data: {
          organizationId,
          aggregateId: incident.id,
          type: "SAFETY_INCIDENT_CLOSED",
          payload: {
            incidentId: incident.id,
            resolutionCode: input.resolutionCode,
          },
        },
      });
      return this.toView(
        await tx.safetyIncident.findUniqueOrThrow({
          where: { id: incident.id },
        }),
      );
    });
  }

  async escalateDue(now = new Date(), limit = 20) {
    const due = await this.prisma.safetyIncident.findMany({
      where: {
        status: SafetyIncidentStatus.OPEN,
        acknowledgementDueAt: { lte: now },
      },
      orderBy: { acknowledgementDueAt: "asc" },
      take: Math.max(1, Math.min(limit, 100)),
    });
    let escalated = 0;
    for (const candidate of due) {
      const changed = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "SafetyIncident" WHERE "id" = ${candidate.id} FOR UPDATE`;
        const incident = await tx.safetyIncident.findUnique({
          where: { id: candidate.id },
        });
        if (
          !incident ||
          incident.status !== SafetyIncidentStatus.OPEN ||
          incident.acknowledgementDueAt.getTime() > now.getTime()
        )
          return false;
        await this.escalateLocked(tx, incident, now);
        return true;
      });
      if (changed) escalated++;
    }
    return escalated;
  }

  private async escalateLocked(
    tx: Prisma.TransactionClient,
    incident: SafetyIncident,
    now: Date,
  ) {
    const updated = await tx.safetyIncident.updateMany({
      where: { id: incident.id, status: SafetyIncidentStatus.OPEN },
      data: { status: SafetyIncidentStatus.ESCALATED, escalatedAt: now },
    });
    if (updated.count !== 1) return false;
    await tx.safetyIncidentEvent.create({
      data: {
        incidentId: incident.id,
        type: "SAFETY_INCIDENT_ESCALATED",
        payload: {
          missedPrimaryUserId: incident.primaryUserId,
          backupUserId: incident.backupUserId,
        },
      },
    });
    await tx.auditLog.create({
      data: {
        organizationId: incident.organizationId,
        action: "SAFETY_INCIDENT_ESCALATED",
        resourceType: "SafetyIncident",
        resourceId: incident.id,
        metadata: {
          missedPrimaryUserId: incident.primaryUserId,
          backupUserId: incident.backupUserId,
        },
      },
    });
    await tx.outboxEvent.create({
      data: {
        organizationId: incident.organizationId,
        aggregateId: incident.id,
        type: "SAFETY_INCIDENT_ESCALATED",
        payload: {
          incidentId: incident.id,
          organizationId: incident.organizationId,
          backupUserId: incident.backupUserId,
        },
      },
    });
    return true;
  }

  private async findByIdempotency(
    reporterUserId: string,
    idempotencyKey: string,
  ) {
    return this.prisma.safetyIncident.findUnique({
      where: {
        reporterUserId_idempotencyKey: { reporterUserId, idempotencyKey },
      },
    });
  }

  private replay(incident: SafetyIncident, requestFingerprint: string) {
    if (incident.requestFingerprint !== requestFingerprint)
      throw new ConflictException("幂等键已用于不同的安全事件请求");
    return { data: this.toCustomerView(incident), idempotentReplay: true };
  }

  private fingerprint(value: unknown) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  }

  private toRosterView(roster: {
    id: string;
    organizationId: string;
    primaryUserId: string;
    backupUserId: string;
    acknowledgementTimeoutSeconds: number;
    active: boolean;
    createdAt: Date;
  }) {
    return {
      id: roster.id,
      organizationId: roster.organizationId,
      primaryUserId: roster.primaryUserId,
      backupUserId: roster.backupUserId,
      acknowledgementTimeoutSeconds: roster.acknowledgementTimeoutSeconds,
      active: roster.active,
      createdAt: roster.createdAt.toISOString(),
    };
  }

  private toView(incident: SafetyIncident): SafetyIncidentView {
    return {
      id: incident.id,
      organizationId: incident.organizationId,
      orderId: incident.orderId,
      category: incident.category,
      status: incident.status,
      primaryUserId: incident.primaryUserId,
      backupUserId: incident.backupUserId,
      acknowledgementDueAt: incident.acknowledgementDueAt.toISOString(),
      acknowledgedById: incident.acknowledgedById,
      acknowledgedAt: incident.acknowledgedAt?.toISOString() ?? null,
      escalatedAt: incident.escalatedAt?.toISOString() ?? null,
      resolutionCode: incident.resolutionCode,
      closedAt: incident.closedAt?.toISOString() ?? null,
      createdAt: incident.createdAt.toISOString(),
    };
  }

  private toCustomerView(incident: SafetyIncident): SafetyIncidentCustomerView {
    const {
      primaryUserId: _primary,
      backupUserId: _backup,
      ...safe
    } = this.toView(incident);
    return safe;
  }
}
