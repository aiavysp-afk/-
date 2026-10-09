import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  MembershipStatus,
  Prisma,
  TechnicianInvitationStatus,
  TechnicianProfileStatus,
  UserRole,
} from "@prisma/client";
import type {
  TechnicianInvitation,
  TechnicianInvitationClaimed,
  TechnicianInvitationCreate,
  TechnicianInvitationCreated,
} from "@zydj/contracts";
import { randomBytes } from "node:crypto";
import { AccessControlService } from "../auth/access-control.service.js";
import { AuthCryptoService } from "../auth/auth-crypto.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { PrismaService } from "../database/prisma.service.js";

type InvitationRecord = Prisma.TechnicianInvitationGetPayload<{
  include: {
    organization: { select: { name: true } };
    claimedBy: { select: { displayName: true } };
  };
}>;

@Injectable()
export class TechnicianInvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly crypto: AuthCryptoService,
  ) {}

  async list(
    principal: AuthPrincipal,
    organizationId: string,
    now = new Date(),
  ): Promise<TechnicianInvitation[]> {
    this.access.assertPermission(
      principal,
      "technicians.manage",
      organizationId,
    );
    const rows = await this.prisma.technicianInvitation.findMany({
      where: { organizationId },
      include: {
        organization: { select: { name: true } },
        claimedBy: { select: { displayName: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 100,
    });
    return rows.map((row) => this.toView(row, now));
  }

  async create(
    principal: AuthPrincipal,
    organizationId: string,
    input: TechnicianInvitationCreate,
    now = new Date(),
  ): Promise<TechnicianInvitationCreated> {
    this.access.assertPermission(
      principal,
      "technicians.manage",
      organizationId,
    );
    const duplicate = await this.prisma.technicianInvitation.findFirst({
      where: {
        organizationId,
        publicName: input.publicName,
        status: TechnicianInvitationStatus.PENDING,
        expiresAt: { gt: now },
      },
      select: { id: true },
    });
    if (duplicate) {
      throw new ConflictException("该公开称呼已有未过期邀请，请先撤销或等待过期");
    }

    const code = randomBytes(9).toString("base64url").toUpperCase();
    const expiresAt = new Date(
      now.getTime() + input.expiresInHours * 60 * 60_000,
    );
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.technicianInvitation.create({
        data: {
          organizationId,
          publicName: input.publicName,
          tokenHash: this.hashCode(code),
          expiresAt,
          createdById: principal.userId,
          createdAt: now,
        },
        include: {
          organization: { select: { name: true } },
          claimedBy: { select: { displayName: true } },
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId,
          action: "TECHNICIAN_INVITATION_CREATED",
          resourceType: "TechnicianInvitation",
          resourceId: created.id,
          metadata: {
            publicName: created.publicName,
            expiresAt: created.expiresAt.toISOString(),
          },
        },
      });
      return created;
    });
    return {
      invitation: this.toView(row, now),
      code,
      miniappPath: `/pages/technician-onboarding/index?code=${encodeURIComponent(code)}`,
    };
  }

  async revoke(
    principal: AuthPrincipal,
    organizationId: string,
    invitationId: string,
    now = new Date(),
  ): Promise<TechnicianInvitation> {
    this.access.assertPermission(
      principal,
      "technicians.manage",
      organizationId,
    );
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.technicianInvitation.findFirst({
        where: { id: invitationId, organizationId },
        include: {
          organization: { select: { name: true } },
          claimedBy: { select: { displayName: true } },
        },
      });
      if (!current) throw new NotFoundException("技师邀请不存在");
      if (
        current.status !== TechnicianInvitationStatus.PENDING ||
        current.expiresAt <= now
      ) {
        throw new ConflictException("该邀请已失效，不能撤销");
      }
      const changed = await tx.technicianInvitation.updateMany({
        where: {
          id: invitationId,
          organizationId,
          status: TechnicianInvitationStatus.PENDING,
          claimedById: null,
          expiresAt: { gt: now },
        },
        data: {
          status: TechnicianInvitationStatus.REVOKED,
          revokedAt: now,
        },
      });
      if (changed.count !== 1) {
        throw new ConflictException("邀请状态已变化，请刷新后重试");
      }
      const updated = await tx.technicianInvitation.findUniqueOrThrow({
        where: { id: invitationId },
        include: {
          organization: { select: { name: true } },
          claimedBy: { select: { displayName: true } },
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId,
          action: "TECHNICIAN_INVITATION_REVOKED",
          resourceType: "TechnicianInvitation",
          resourceId: invitationId,
          metadata: { publicName: current.publicName },
        },
      });
      return this.toView(updated, now);
    });
  }

  async claim(
    principal: AuthPrincipal,
    code: string,
    now = new Date(),
  ): Promise<TechnicianInvitationClaimed> {
    await this.takeClaimRateLimit(principal.userId, now);
    const tokenHash = this.hashCode(code);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${principal.userId} FOR NO KEY UPDATE`;
      const user = await tx.user.findUnique({
        where: { id: principal.userId },
        select: {
          id: true,
          status: true,
          phoneVerifiedAt: true,
          displayName: true,
        },
      });
      if (!user || user.status !== "ACTIVE") {
        throw new ForbiddenException("当前账号不可认领技师身份");
      }
      if (!user.phoneVerifiedAt) {
        throw new ForbiddenException("请先完成本人手机号验证，再认领技师身份");
      }

      await tx.$queryRaw`SELECT "id" FROM "TechnicianInvitation" WHERE "tokenHash" = ${tokenHash} FOR UPDATE`;
      const invitation = await tx.technicianInvitation.findUnique({
        where: { tokenHash },
        include: { organization: { select: { name: true } } },
      });
      if (
        !invitation ||
        invitation.status !== TechnicianInvitationStatus.PENDING ||
        invitation.expiresAt <= now
      ) {
        throw new NotFoundException("邀请码无效、已使用或已过期");
      }

      const existingProfile = await tx.technicianProfile.findUnique({
        where: { technicianId: principal.userId },
        select: { organizationId: true },
      });
      if (existingProfile) {
        throw new ConflictException(
          existingProfile.organizationId === invitation.organizationId
            ? "当前账号已是该组织技师，无需重复认领"
            : "当前账号已绑定其他组织，请联系后台核验",
        );
      }

      await tx.staffMembership.upsert({
        where: {
          userId_organizationId_role: {
            userId: principal.userId,
            organizationId: invitation.organizationId,
            role: UserRole.THERAPIST,
          },
        },
        create: {
          userId: principal.userId,
          organizationId: invitation.organizationId,
          role: UserRole.THERAPIST,
          status: MembershipStatus.ACTIVE,
        },
        update: { status: MembershipStatus.ACTIVE },
      });
      await tx.technicianProfile.upsert({
        where: { technicianId: principal.userId },
        create: {
          organizationId: invitation.organizationId,
          technicianId: principal.userId,
          publicName: invitation.publicName,
          status: TechnicianProfileStatus.DRAFT,
        },
        update: {},
      });
      const changed = await tx.technicianInvitation.updateMany({
        where: {
          id: invitation.id,
          status: TechnicianInvitationStatus.PENDING,
          claimedById: null,
          expiresAt: { gt: now },
        },
        data: {
          status: TechnicianInvitationStatus.CLAIMED,
          claimedById: principal.userId,
          claimedAt: now,
        },
      });
      if (changed.count !== 1) {
        throw new ConflictException("邀请码已被使用，请联系后台重新生成");
      }
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId: invitation.organizationId,
          action: "TECHNICIAN_INVITATION_CLAIMED",
          resourceType: "TechnicianInvitation",
          resourceId: invitation.id,
          metadata: {
            publicName: invitation.publicName,
            profileStatus: TechnicianProfileStatus.DRAFT,
          },
        },
      });
      await tx.outboxEvent.create({
        data: {
          organizationId: invitation.organizationId,
          aggregateId: invitation.id,
          type: "technician.invitation.claimed",
          payload: {
            invitationId: invitation.id,
            technicianId: principal.userId,
          },
        },
      });
      return {
        invitationId: invitation.id,
        organizationId: invitation.organizationId,
        organizationName: invitation.organization.name,
        publicName: invitation.publicName,
        profileStatus: "DRAFT",
        claimedAt: now.toISOString(),
      };
    });
  }

  private async takeClaimRateLimit(userId: string, now: Date) {
    const windowMs = 60 * 60_000;
    const bucket = Math.floor(now.getTime() / windowMs);
    const key = this.crypto.hashBrowserLogin(
      "technician-invitation-rate",
      `${userId}:${bucket}`,
    );
    const row = await this.prisma.browserLoginRateLimit.upsert({
      where: { key },
      create: {
        key,
        count: 1,
        expiresAt: new Date((bucket + 2) * windowMs),
      },
      update: { count: { increment: 1 } },
    });
    if (row.count > 8) {
      throw new HttpException("邀请码尝试次数过多，请一小时后重试", 429);
    }
  }

  private hashCode(code: string) {
    return this.crypto.hashBrowserLogin(
      "technician-invitation",
      code.trim().toUpperCase(),
    );
  }

  private toView(
    row: InvitationRecord,
    now: Date,
  ): TechnicianInvitation {
    const status =
      row.status === TechnicianInvitationStatus.PENDING && row.expiresAt <= now
        ? "EXPIRED"
        : row.status;
    return {
      id: row.id,
      organizationId: row.organizationId,
      organizationName: row.organization.name,
      publicName: row.publicName,
      status,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      claimedAt: row.claimedAt?.toISOString() ?? null,
      claimedDisplayName: row.claimedBy?.displayName ?? null,
    };
  }
}
