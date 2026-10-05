import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { MembershipStatus, UserRole } from "@prisma/client";
import type {
  SafetyDutyContactUpdate,
  SafetyNotificationView,
} from "@zydj/contracts";
import { AuthCryptoService } from "../auth/auth-crypto.service.js";
import { AccessControlService } from "../auth/access-control.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { PrismaService } from "../database/prisma.service.js";

const EVENT_TYPES = ["SAFETY_INCIDENT_OPENED", "SAFETY_INCIDENT_ESCALATED"];

@Injectable()
export class SafetyNotificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly crypto: AuthCryptoService,
  ) {}

  async updateDutyContact(
    principal: AuthPrincipal,
    organizationId: string,
    userId: string,
    input: SafetyDutyContactUpdate,
  ) {
    this.access.assertPermission(principal, "iam.manage", organizationId);
    const membership = await this.prisma.staffMembership.findFirst({
      where: {
        organizationId,
        userId,
        role: UserRole.SAFETY_DUTY,
        status: MembershipStatus.ACTIVE,
        user: { status: "ACTIVE" },
      },
      select: { id: true },
    });
    if (!membership) throw new NotFoundException("安全值班人员不存在或已停用");
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { phoneEncrypted: this.crypto.encrypt(input.phone) },
      });
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId,
          action: "SAFETY_DUTY_CONTACT_UPDATED",
          resourceType: "User",
          resourceId: userId,
          metadata: { phoneConfigured: true },
        },
      });
    });
    return { userId, phoneConfigured: true };
  }

  async list(
    principal: AuthPrincipal,
    organizationId: string,
  ): Promise<SafetyNotificationView[]> {
    this.access.assertPermission(principal, "safety.respond", organizationId);
    const rows = await this.prisma.outboxEvent.findMany({
      where: { organizationId, type: { in: EVENT_TYPES } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return rows.map((row) => ({
      id: row.id,
      incidentId: row.aggregateId,
      type: row.type as SafetyNotificationView["type"],
      state: row.publishedAt
        ? "ACCEPTED"
        : row.deadLetteredAt
          ? "DEAD_LETTER"
          : "PENDING",
      attempts: row.attempts,
      nextAttemptAt: row.nextAttemptAt.toISOString(),
      lastErrorCode: row.lastErrorCode,
      createdAt: row.createdAt.toISOString(),
      publishedAt: row.publishedAt?.toISOString() ?? null,
      deadLetteredAt: row.deadLetteredAt?.toISOString() ?? null,
    }));
  }

  async retry(
    principal: AuthPrincipal,
    organizationId: string,
    outboxId: string,
    now = new Date(),
  ) {
    this.access.assertPermission(principal, "iam.manage", organizationId);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "OutboxEvent" WHERE "id" = ${outboxId} FOR UPDATE`;
      const event = await tx.outboxEvent.findUnique({
        where: { id: outboxId },
      });
      if (
        !event ||
        event.organizationId !== organizationId ||
        !EVENT_TYPES.includes(event.type)
      )
        throw new NotFoundException("安全通知事件不存在");
      if (event.publishedAt)
        throw new ConflictException("已被渠道接受的通知不能重复发送");
      if (!event.deadLetteredAt)
        throw new ConflictException("只有人工复核后的失败通知可以重试");
      const updated = await tx.outboxEvent.update({
        where: { id: event.id },
        data: {
          deadLetteredAt: null,
          lastErrorCode: null,
          providerReference: null,
          nextAttemptAt: now,
          leaseToken: null,
          leaseUntil: null,
          dispatchStartedAt: null,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId,
          action: "SAFETY_NOTIFICATION_RETRY_REQUESTED",
          resourceType: "OutboxEvent",
          resourceId: event.id,
          metadata: { previousErrorCode: event.lastErrorCode },
        },
      });
      return {
        id: updated.id,
        state: "PENDING" as const,
        nextAttemptAt: updated.nextAttemptAt.toISOString(),
      };
    });
  }
}
