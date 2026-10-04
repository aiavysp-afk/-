import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { MfaRecoveryStatus, Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../database/prisma.service.js";
import { AccessControlService } from "./access-control.service.js";
import type { AuthPrincipal } from "./auth.types.js";

const STAFF_ROLES = [
  "THERAPIST",
  "OPERATOR",
  "DISPATCHER",
  "FINANCE_REQUESTER",
  "FINANCE_APPROVER",
  "SAFETY_DUTY",
  "ADMIN",
] as const;
export const MFA_RECOVERY_REJECTION_CODES = [
  "IDENTITY_NOT_CONFIRMED",
  "REQUEST_NOT_EXPECTED",
  "POLICY_REVIEW_REQUIRED",
] as const;
export type MfaRecoveryRejectionCode =
  (typeof MFA_RECOVERY_REJECTION_CODES)[number];

@Injectable()
export class MfaRecoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly access: AccessControlService,
  ) {}

  private view(
    row: {
      id: string;
      organizationId: string;
      targetUserId: string;
      status: MfaRecoveryStatus;
      reasonCode: string | null;
      createdAt: Date;
      expiresAt: Date;
      reviewedAt: Date | null;
      executedAt: Date | null;
      organization?: { name: string };
      targetUser?: { displayName: string };
    },
    now = new Date(),
  ) {
    return {
      id: row.id,
      organizationId: row.organizationId,
      organizationName: row.organization?.name ?? null,
      targetUserId: row.targetUserId,
      targetDisplayName: row.targetUser?.displayName ?? null,
      status:
        row.status === MfaRecoveryStatus.PENDING && row.expiresAt <= now
          ? MfaRecoveryStatus.EXPIRED
          : row.status,
      reasonCode: row.reasonCode,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
      executedAt: row.executedAt?.toISOString() ?? null,
    };
  }

  private async lockUser(tx: Prisma.TransactionClient, userId: string) {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR NO KEY UPDATE`;
  }

  private async lockSession(tx: Prisma.TransactionClient, sessionId: string) {
    await tx.$queryRaw`SELECT "id" FROM "Session" WHERE "id" = ${sessionId} FOR UPDATE`;
  }

  private async lockRequest(tx: Prisma.TransactionClient, requestId: string) {
    await tx.$queryRaw`SELECT "id" FROM "MfaRecoveryRequest" WHERE "id" = ${requestId} FOR UPDATE`;
  }

  async request(
    principal: AuthPrincipal,
    organizationId: string,
    now = new Date(),
  ) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockUser(tx, principal.userId);
      await this.lockSession(tx, principal.sessionId);
      const user = await tx.user.findUnique({
        where: { id: principal.userId },
        include: { memberships: { where: { status: "ACTIVE" } } },
      });
      const session = await tx.session.findUnique({
        where: { id: principal.sessionId },
      });
      if (
        !user ||
        user.status !== "ACTIVE" ||
        !session ||
        session.userId !== user.id ||
        session.revokedAt ||
        session.expiresAt <= now
      )
        throw new UnauthorizedException("会话已失效");
      const membership = user.memberships.find(
        (item) => item.organizationId === organizationId,
      );
      if (!membership || !STAFF_ROLES.some((role) => role === membership.role))
        throw new ForbiddenException("当前身份不是该组织的授权工作人员");
      if (
        session.authChannel !== "WECHAT_MINIAPP" ||
        session.authProvider !== this.config.get("AUTH_PROVIDER") ||
        session.createdAt.getTime() < now.getTime() - 300_000 ||
        session.createdAt > now
      )
        throw new UnauthorizedException(
          "请在小程序中重新完成微信登录后申请恢复",
        );
      const credential = await tx.mfaCredential.findUnique({
        where: { userId: user.id },
      });
      if (!credential?.enabledAt)
        throw new ConflictException("当前没有可恢复的已启用验证器");
      await tx.mfaRecoveryRequest.updateMany({
        where: {
          targetUserId: user.id,
          status: MfaRecoveryStatus.PENDING,
          expiresAt: { lte: now },
        },
        data: {
          status: MfaRecoveryStatus.EXPIRED,
          reasonCode: "EXPIRED",
          reviewedAt: now,
        },
      });
      const recent = await tx.mfaRecoveryRequest.count({
        where: {
          targetUserId: user.id,
          createdAt: { gte: new Date(now.getTime() - 86_400_000) },
        },
      });
      if (recent >= 3)
        throw new HttpException("恢复申请过于频繁，请联系安全负责人", 429);
      const pending = await tx.mfaRecoveryRequest.findFirst({
        where: {
          targetUserId: user.id,
          status: MfaRecoveryStatus.PENDING,
        },
      });
      if (pending) throw new ConflictException("已有待复核的恢复申请");
      const request = await tx.mfaRecoveryRequest.create({
        data: {
          id: randomUUID(),
          organizationId,
          targetUserId: user.id,
          sourceSessionId: session.id,
          expiresAt: new Date(now.getTime() + 1_800_000),
        },
        include: { organization: { select: { name: true } } },
      });
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: "MFA_RECOVERY_REQUESTED",
          resourceType: "MfaRecoveryRequest",
          resourceId: request.id,
          metadata: { organizationId, sourceSessionId: session.id },
        },
      });
      return this.view(request, now);
    });
  }

  async listOwn(principal: AuthPrincipal, now = new Date()) {
    const rows = await this.prisma.mfaRecoveryRequest.findMany({
      where: { targetUserId: principal.userId },
      include: { organization: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    return rows.map((row) => this.view(row, now));
  }

  async cancel(principal: AuthPrincipal, requestId: string, now = new Date()) {
    const snapshot = await this.prisma.mfaRecoveryRequest.findUnique({
      where: { id: requestId },
    });
    if (!snapshot || snapshot.targetUserId !== principal.userId)
      throw new NotFoundException("恢复申请不存在");
    return this.prisma.$transaction(async (tx) => {
      await this.lockUser(tx, principal.userId);
      await this.lockSession(tx, principal.sessionId);
      await this.lockRequest(tx, requestId);
      const [request, session] = await Promise.all([
        tx.mfaRecoveryRequest.findUnique({
          where: { id: requestId },
          include: { organization: { select: { name: true } } },
        }),
        tx.session.findUnique({ where: { id: principal.sessionId } }),
      ]);
      if (!request || request.targetUserId !== principal.userId)
        throw new NotFoundException("恢复申请不存在");
      if (
        !session ||
        session.userId !== principal.userId ||
        session.revokedAt ||
        session.expiresAt <= now ||
        request.sourceSessionId !== session.id
      )
        throw new UnauthorizedException("只能由原申请会话取消");
      if (request.status !== MfaRecoveryStatus.PENDING)
        throw new ConflictException("恢复申请已处理");
      const status =
        request.expiresAt <= now
          ? MfaRecoveryStatus.EXPIRED
          : MfaRecoveryStatus.CANCELLED;
      const updated = await tx.mfaRecoveryRequest.update({
        where: { id: request.id },
        data: {
          status,
          reasonCode:
            status === MfaRecoveryStatus.EXPIRED
              ? "EXPIRED"
              : "REQUESTER_CANCELLED",
          reviewedAt: now,
        },
        include: { organization: { select: { name: true } } },
      });
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          action:
            status === MfaRecoveryStatus.EXPIRED
              ? "MFA_RECOVERY_EXPIRED"
              : "MFA_RECOVERY_CANCELLED",
          resourceType: "MfaRecoveryRequest",
          resourceId: request.id,
          metadata: { organizationId: request.organizationId },
        },
      });
      return this.view(updated, now);
    });
  }

  async listForReview(
    principal: AuthPrincipal,
    organizationId: string,
    now = new Date(),
  ) {
    this.access.assertPermission(principal, "iam.manage", organizationId);
    const rows = await this.prisma.mfaRecoveryRequest.findMany({
      where: { organizationId },
      include: { targetUser: { select: { displayName: true } } },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return rows.map((row) => this.view(row, now));
  }

  async approve(
    principal: AuthPrincipal,
    organizationId: string,
    requestId: string,
    now = new Date(),
  ) {
    return this.review(
      principal,
      organizationId,
      requestId,
      "APPROVED",
      null,
      now,
    );
  }

  async reject(
    principal: AuthPrincipal,
    organizationId: string,
    requestId: string,
    reasonCode: MfaRecoveryRejectionCode,
    now = new Date(),
  ) {
    return this.review(
      principal,
      organizationId,
      requestId,
      "REJECTED",
      reasonCode,
      now,
    );
  }

  private async review(
    principal: AuthPrincipal,
    organizationId: string,
    requestId: string,
    decision: "APPROVED" | "REJECTED",
    reasonCode: MfaRecoveryRejectionCode | null,
    now: Date,
  ) {
    this.access.assertPermission(principal, "iam.manage", organizationId);
    const snapshot = await this.prisma.mfaRecoveryRequest.findUnique({
      where: { id: requestId },
    });
    if (!snapshot || snapshot.organizationId !== organizationId)
      throw new NotFoundException("恢复申请不存在");
    if (snapshot.targetUserId === principal.userId)
      throw new ForbiddenException("申请人不能复核自己的恢复申请");
    const result = await this.prisma.$transaction(async (tx) => {
      for (const userId of [principal.userId, snapshot.targetUserId].sort())
        await this.lockUser(tx, userId);
      for (const sessionId of [
        principal.sessionId,
        snapshot.sourceSessionId,
      ].sort())
        await this.lockSession(tx, sessionId);
      await this.lockRequest(tx, requestId);
      const request = await tx.mfaRecoveryRequest.findUnique({
        where: { id: requestId },
        include: { targetUser: { select: { displayName: true } } },
      });
      if (!request || request.organizationId !== organizationId)
        throw new NotFoundException("恢复申请不存在");
      if (request.targetUserId === principal.userId)
        throw new ForbiddenException("申请人不能复核自己的恢复申请");
      if (request.status !== MfaRecoveryStatus.PENDING)
        throw new ConflictException("恢复申请已处理");
      if (request.expiresAt <= now) {
        await tx.mfaRecoveryRequest.update({
          where: { id: request.id },
          data: {
            status: MfaRecoveryStatus.EXPIRED,
            reasonCode: "EXPIRED",
            reviewedAt: now,
          },
        });
        return { expired: true as const };
      }
      const [reviewer, target, reviewerSession, sourceSession, credential] =
        await Promise.all([
          tx.user.findUnique({
            where: { id: principal.userId },
            include: { memberships: { where: { status: "ACTIVE" } } },
          }),
          tx.user.findUnique({
            where: { id: request.targetUserId },
            include: { memberships: { where: { status: "ACTIVE" } } },
          }),
          tx.session.findUnique({ where: { id: principal.sessionId } }),
          tx.session.findUnique({ where: { id: request.sourceSessionId } }),
          tx.mfaCredential.findUnique({
            where: { userId: request.targetUserId },
          }),
        ]);
      if (
        !reviewer ||
        reviewer.status !== "ACTIVE" ||
        !reviewer.memberships.some(
          (item) =>
            item.organizationId === organizationId && item.role === "ADMIN",
        ) ||
        !reviewerSession ||
        reviewerSession.userId !== reviewer.id ||
        reviewerSession.revokedAt ||
        reviewerSession.expiresAt <= now ||
        !reviewerSession.mfaVerifiedUntil ||
        reviewerSession.mfaVerifiedUntil <= now
      )
        throw new ForbiddenException("复核人必须是已完成MFA的同组织管理员");
      if (
        !target ||
        target.status !== "ACTIVE" ||
        !target.memberships.some(
          (item) => item.organizationId === organizationId,
        )
      )
        throw new ForbiddenException("申请人的组织资格已失效");
      if (
        !sourceSession ||
        sourceSession.userId !== target.id ||
        sourceSession.revokedAt ||
        sourceSession.expiresAt <= now ||
        sourceSession.authChannel !== "WECHAT_MINIAPP" ||
        sourceSession.authProvider !== this.config.get("AUTH_PROVIDER")
      )
        throw new ConflictException("申请来源微信会话已失效");
      if (!credential?.enabledAt)
        throw new ConflictException("申请人的原验证器状态已变化");
      if (decision === "REJECTED") {
        const rejected = await tx.mfaRecoveryRequest.update({
          where: { id: request.id },
          data: {
            status: MfaRecoveryStatus.REJECTED,
            reviewerUserId: reviewer.id,
            reviewerSessionId: reviewerSession.id,
            reasonCode,
            reviewedAt: now,
          },
          include: { targetUser: { select: { displayName: true } } },
        });
        await this.auditReview(
          tx,
          reviewer.id,
          request.id,
          organizationId,
          target.id,
          "MFA_RECOVERY_REJECTED",
          reasonCode,
        );
        return { expired: false as const, data: this.view(rejected, now) };
      }
      await tx.mfaCredential.delete({ where: { userId: target.id } });
      const revoked = await tx.session.updateMany({
        where: { userId: target.id, revokedAt: null },
        data: { revokedAt: now, mfaVerifiedUntil: null },
      });
      const approved = await tx.mfaRecoveryRequest.update({
        where: { id: request.id },
        data: {
          status: MfaRecoveryStatus.APPROVED,
          reviewerUserId: reviewer.id,
          reviewerSessionId: reviewerSession.id,
          reviewedAt: now,
          executedAt: now,
        },
        include: { targetUser: { select: { displayName: true } } },
      });
      await this.auditReview(
        tx,
        reviewer.id,
        request.id,
        organizationId,
        target.id,
        "MFA_RECOVERY_APPROVED",
        null,
      );
      return {
        expired: false as const,
        data: { ...this.view(approved, now), revokedSessions: revoked.count },
      };
    });
    if (result.expired)
      throw new ConflictException("恢复申请已过期，请由本人重新申请");
    return result.data;
  }

  private async auditReview(
    tx: Prisma.TransactionClient,
    actorId: string,
    requestId: string,
    organizationId: string,
    targetUserId: string,
    action: string,
    reasonCode: string | null,
  ) {
    await tx.auditLog.create({
      data: {
        actorId,
        action,
        resourceType: "MfaRecoveryRequest",
        resourceId: requestId,
        metadata: { organizationId, targetUserId, reasonCode },
      },
    });
  }
}
