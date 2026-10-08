import {
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import {
  MembershipStatus,
  OrderStatus,
  Prisma,
  TechnicianProfileStatus,
  TechnicianReviewStatus,
  UserRole,
} from "@prisma/client";
import type {
  AdminTechnicianReview,
  TechnicianProfile,
  TechnicianProfileUpdate,
  TechnicianReview,
  TechnicianReviewCreate,
} from "@zydj/contracts";
import { AccessControlService } from "../auth/access-control.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { PrismaService } from "../database/prisma.service.js";

type ProfileRecord = {
  id: string;
  organizationId: string;
  technicianId: string;
  publicName: string;
  avatarUrl: string | null;
  galleryUrls: Prisma.JsonValue;
  introduction: string;
  specialties: Prisma.JsonValue;
  serviceYears: number | null;
  certificates: Prisma.JsonValue;
  status: TechnicianProfileStatus;
  rejectionReason: string | null;
  updatedAt: Date;
  technician: { displayName: string };
};

@Injectable()
export class TechniciansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
  ) {}

  async listPublic(): Promise<TechnicianProfile[]> {
    const profiles = await this.prisma.technicianProfile.findMany({
      where: {
        status: TechnicianProfileStatus.PUBLISHED,
        technician: { status: "ACTIVE" },
      },
      include: { technician: { select: { displayName: true } } },
      orderBy: [{ updatedAt: "desc" }, { publicName: "asc" }],
      take: 100,
    });
    if (!profiles.length) return [];

    const activeMemberships = await this.prisma.staffMembership.findMany({
      where: {
        userId: { in: profiles.map((profile) => profile.technicianId) },
        role: UserRole.THERAPIST,
        status: MembershipStatus.ACTIVE,
      },
      select: { userId: true, organizationId: true },
    });
    const allowed = new Set(
      activeMemberships.map(
        ({ userId, organizationId }) => `${userId}:${organizationId}`,
      ),
    );
    return Promise.all(
      profiles
        .filter((profile) =>
          allowed.has(`${profile.technicianId}:${profile.organizationId}`),
        )
        .map((profile) => this.toProfile(profile, true)),
    );
  }

  async getPublic(technicianId: string): Promise<TechnicianProfile> {
    const profile = await this.prisma.technicianProfile.findFirst({
      where: {
        technicianId,
        status: TechnicianProfileStatus.PUBLISHED,
        technician: { status: "ACTIVE" },
      },
      include: { technician: { select: { displayName: true } } },
    });
    if (!profile || !(await this.hasActiveMembership(profile))) {
      throw new NotFoundException("技师资料不存在或尚未发布");
    }
    return this.toProfile(profile, true);
  }

  async listPublicReviews(technicianId: string): Promise<TechnicianReview[]> {
    const profile = await this.getPublicProfileRecord(technicianId);
    const rows = await this.prisma.technicianReview.findMany({
      where: {
        organizationId: profile.organizationId,
        technicianId,
        status: TechnicianReviewStatus.PUBLISHED,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 100,
    });
    return rows.map((row) => this.toReview(row));
  }

  async getOwnProfile(principal: AuthPrincipal): Promise<TechnicianProfile> {
    const membership = await this.getOwnMembership(principal);
    const profile = await this.ensureProfile(
      membership.organizationId,
      principal.userId,
      principal.displayName,
    );
    return this.toProfile(profile, false);
  }

  async updateOwnProfile(
    principal: AuthPrincipal,
    input: TechnicianProfileUpdate,
  ): Promise<TechnicianProfile> {
    const membership = await this.getOwnMembership(principal);
    const current = await this.ensureProfile(
      membership.organizationId,
      principal.userId,
      principal.displayName,
    );
    const data = this.profileUpdateData(input);
    data.status = TechnicianProfileStatus.DRAFT;
    data.rejectionReason = null;
    data.reviewedById = null;
    data.reviewedAt = null;
    const updated = await this.prisma.$transaction(async (tx) => {
      const record = await tx.technicianProfile.update({
        where: { technicianId: principal.userId },
        data,
        include: { technician: { select: { displayName: true } } },
      });
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId: current.organizationId,
          action: "TECHNICIAN_PROFILE_SELF_UPDATED",
          resourceType: "TechnicianProfile",
          resourceId: current.id,
          metadata: { changedFields: Object.keys(input).sort() },
        },
      });
      return record;
    });
    return this.toProfile(updated, false);
  }

  async submitOwnProfile(principal: AuthPrincipal): Promise<TechnicianProfile> {
    const membership = await this.getOwnMembership(principal);
    const current = await this.ensureProfile(
      membership.organizationId,
      principal.userId,
      principal.displayName,
    );
    if (current.status === TechnicianProfileStatus.PENDING_REVIEW) {
      return this.toProfile(current, false);
    }
    if (
      current.status !== TechnicianProfileStatus.DRAFT &&
      current.status !== TechnicianProfileStatus.REJECTED
    ) {
      throw new ConflictException("当前资料状态不能重复提交审核");
    }
    this.assertProfileComplete(current);
    const updated = await this.changeStatus(
      principal,
      current,
      TechnicianProfileStatus.PENDING_REVIEW,
      "TECHNICIAN_PROFILE_SUBMITTED",
    );
    return this.toProfile(updated, false);
  }

  async getAdminProfile(
    principal: AuthPrincipal,
    organizationId: string,
    technicianId: string,
  ): Promise<TechnicianProfile> {
    this.access.assertPermission(
      principal,
      "technicians.manage",
      organizationId,
    );
    const membership = await this.getTechnicianMembership(
      organizationId,
      technicianId,
    );
    const profile = await this.ensureProfile(
      organizationId,
      technicianId,
      membership.user.displayName,
    );
    return this.toProfile(profile, false);
  }

  async updateAdminProfile(
    principal: AuthPrincipal,
    organizationId: string,
    technicianId: string,
    input: TechnicianProfileUpdate,
  ): Promise<TechnicianProfile> {
    this.access.assertPermission(
      principal,
      "technicians.manage",
      organizationId,
    );
    const membership = await this.getTechnicianMembership(
      organizationId,
      technicianId,
    );
    const current = await this.ensureProfile(
      organizationId,
      technicianId,
      membership.user.displayName,
    );
    const updated = await this.prisma.$transaction(async (tx) => {
      const data = this.profileUpdateData(input);
      if (current.status === TechnicianProfileStatus.PUBLISHED) {
        data.status = TechnicianProfileStatus.APPROVED;
        data.rejectionReason = null;
        data.reviewedById = principal.userId;
        data.reviewedAt = new Date();
      }
      const changed = await tx.technicianProfile.updateMany({
        where: { id: current.id, status: current.status },
        data,
      });
      if (changed.count !== 1) {
        throw new ConflictException("技师资料审核状态已变化");
      }
      const record = await tx.technicianProfile.findUniqueOrThrow({
        where: { id: current.id },
        include: { technician: { select: { displayName: true } } },
      });
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId,
          action: "TECHNICIAN_PROFILE_ADMIN_UPDATED",
          resourceType: "TechnicianProfile",
          resourceId: current.id,
          metadata: {
            changedFields: Object.keys(input).sort(),
            previousStatus: current.status,
            status: record.status,
          },
        },
      });
      return record;
    });
    return this.toProfile(updated, false);
  }

  async approve(
    principal: AuthPrincipal,
    organizationId: string,
    technicianId: string,
  ): Promise<TechnicianProfile> {
    const current = await this.getAuthorizedProfile(
      principal,
      organizationId,
      technicianId,
    );
    if (current.status === TechnicianProfileStatus.APPROVED) {
      return this.toProfile(current, false);
    }
    if (current.status !== TechnicianProfileStatus.PENDING_REVIEW) {
      throw new ConflictException("仅待审核资料可以批准");
    }
    this.assertProfileComplete(current);
    const updated = await this.changeStatus(
      principal,
      current,
      TechnicianProfileStatus.APPROVED,
      "TECHNICIAN_PROFILE_APPROVED",
      true,
    );
    return this.toProfile(updated, false);
  }

  async publish(
    principal: AuthPrincipal,
    organizationId: string,
    technicianId: string,
  ): Promise<TechnicianProfile> {
    const current = await this.getAuthorizedProfile(
      principal,
      organizationId,
      technicianId,
    );
    if (current.status === TechnicianProfileStatus.PUBLISHED) {
      return this.toProfile(current, false);
    }
    if (current.status !== TechnicianProfileStatus.APPROVED) {
      throw new ConflictException("仅已批准资料可以发布");
    }
    this.assertProfileComplete(current);
    const updated = await this.changeStatus(
      principal,
      current,
      TechnicianProfileStatus.PUBLISHED,
      "TECHNICIAN_PROFILE_PUBLISHED",
      true,
    );
    return this.toProfile(updated, false);
  }

  async unpublish(
    principal: AuthPrincipal,
    organizationId: string,
    technicianId: string,
  ): Promise<TechnicianProfile> {
    const current = await this.getAuthorizedProfile(
      principal,
      organizationId,
      technicianId,
    );
    if (current.status === TechnicianProfileStatus.APPROVED) {
      return this.toProfile(current, false);
    }
    if (current.status !== TechnicianProfileStatus.PUBLISHED) {
      throw new ConflictException("当前资料尚未发布");
    }
    const updated = await this.changeStatus(
      principal,
      current,
      TechnicianProfileStatus.APPROVED,
      "TECHNICIAN_PROFILE_UNPUBLISHED",
      true,
    );
    return this.toProfile(updated, false);
  }

  async createReview(
    principal: AuthPrincipal,
    orderId: string,
    input: TechnicianReviewCreate,
  ): Promise<TechnicianReview> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        organizationId: true,
        customerId: true,
        therapistId: true,
        status: true,
        technicianReview: { select: { id: true } },
      },
    });
    if (!order) throw new NotFoundException("订单不存在");
    if (order.customerId !== principal.userId) {
      throw new ForbiddenException("不能评价其他用户的订单");
    }
    if (order.status !== OrderStatus.COMPLETED) {
      throw new ConflictException("订单完成后才能评价");
    }
    if (!order.therapistId) throw new ConflictException("订单尚未关联技师");
    if (order.technicianReview) throw new ConflictException("该订单已经评价");

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const review = await tx.technicianReview.create({
          data: {
            organizationId: order.organizationId,
            orderId: order.id,
            customerId: principal.userId,
            technicianId: order.therapistId!,
            rating: input.rating,
            content: input.content,
            status: TechnicianReviewStatus.PENDING_REVIEW,
          },
        });
        await tx.orderEvent.create({
          data: {
            orderId: order.id,
            type: "CUSTOMER_REVIEW_CREATED",
            actorId: principal.userId,
            payload: { reviewId: review.id, rating: input.rating },
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: principal.userId,
            organizationId: order.organizationId,
            action: "TECHNICIAN_REVIEW_CREATED",
            resourceType: "TechnicianReview",
            resourceId: review.id,
            metadata: { orderId: order.id, technicianId: order.therapistId },
          },
        });
        await tx.outboxEvent.create({
          data: {
            organizationId: order.organizationId,
            aggregateId: review.id,
            type: "TECHNICIAN_REVIEW_SUBMITTED",
            payload: {
              reviewId: review.id,
              orderId: order.id,
              technicianId: order.therapistId,
            },
          },
        });
        return review;
      });
      return this.toReview(created);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictException("该订单已经评价");
      }
      throw error;
    }
  }

  async listAdminReviews(
    principal: AuthPrincipal,
    organizationId: string,
    technicianId: string,
  ): Promise<AdminTechnicianReview[]> {
    this.access.assertPermission(
      principal,
      "technicians.manage",
      organizationId,
    );
    await this.getTechnicianMembership(organizationId, technicianId);
    const rows = await this.prisma.technicianReview.findMany({
      where: { organizationId, technicianId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 200,
    });
    return rows.map((row) => this.toAdminReview(row));
  }

  async publishReview(
    principal: AuthPrincipal,
    organizationId: string,
    technicianId: string,
    reviewId: string,
  ): Promise<AdminTechnicianReview> {
    return this.moderateReview(
      principal,
      organizationId,
      technicianId,
      reviewId,
      TechnicianReviewStatus.PUBLISHED,
    );
  }

  async hideReview(
    principal: AuthPrincipal,
    organizationId: string,
    technicianId: string,
    reviewId: string,
  ): Promise<AdminTechnicianReview> {
    return this.moderateReview(
      principal,
      organizationId,
      technicianId,
      reviewId,
      TechnicianReviewStatus.HIDDEN,
    );
  }

  private async getPublicProfileRecord(technicianId: string) {
    const profile = await this.prisma.technicianProfile.findFirst({
      where: {
        technicianId,
        status: TechnicianProfileStatus.PUBLISHED,
        technician: { status: "ACTIVE" },
      },
      include: { technician: { select: { displayName: true } } },
    });
    if (!profile || !(await this.hasActiveMembership(profile))) {
      throw new NotFoundException("技师资料不存在或尚未发布");
    }
    return profile;
  }

  private async moderateReview(
    principal: AuthPrincipal,
    organizationId: string,
    technicianId: string,
    reviewId: string,
    status: Exclude<TechnicianReviewStatus, "PENDING_REVIEW">,
  ): Promise<AdminTechnicianReview> {
    this.access.assertPermission(
      principal,
      "technicians.manage",
      organizationId,
    );
    await this.getTechnicianMembership(organizationId, technicianId);
    const current = await this.prisma.technicianReview.findUnique({
      where: { id: reviewId },
    });
    if (
      !current ||
      current.organizationId !== organizationId ||
      current.technicianId !== technicianId
    ) {
      throw new NotFoundException("评价不存在");
    }
    if (current.status === status) return this.toAdminReview(current);

    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.technicianReview.updateMany({
        where: {
          id: reviewId,
          organizationId,
          technicianId,
          status: current.status,
        },
        data: { status },
      });
      if (changed.count !== 1) throw new ConflictException("评价审核状态已变化");
      const updated = await tx.technicianReview.findUniqueOrThrow({
        where: { id: reviewId },
      });
      const action =
        status === TechnicianReviewStatus.PUBLISHED
          ? "TECHNICIAN_REVIEW_PUBLISHED"
          : "TECHNICIAN_REVIEW_HIDDEN";
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId,
          action,
          resourceType: "TechnicianReview",
          resourceId: reviewId,
          metadata: {
            technicianId,
            previousStatus: current.status,
            status,
          },
        },
      });
      await tx.outboxEvent.create({
        data: {
          organizationId,
          aggregateId: reviewId,
          type: action,
          payload: { reviewId, technicianId, status },
        },
      });
      return this.toAdminReview(updated);
    });
  }

  private async hasActiveMembership(profile: {
    organizationId: string;
    technicianId: string;
  }) {
    return !!(await this.prisma.staffMembership.findFirst({
      where: {
        organizationId: profile.organizationId,
        userId: profile.technicianId,
        role: UserRole.THERAPIST,
        status: MembershipStatus.ACTIVE,
      },
      select: { id: true },
    }));
  }

  private async getOwnMembership(principal: AuthPrincipal) {
    const membership = await this.prisma.staffMembership.findFirst({
      where: {
        userId: principal.userId,
        role: UserRole.THERAPIST,
        status: MembershipStatus.ACTIVE,
        user: { status: "ACTIVE" },
      },
      select: { organizationId: true },
      orderBy: { createdAt: "asc" },
    });
    if (!membership) throw new ForbiddenException("当前账号不是有效技师");
    return membership;
  }

  private async getTechnicianMembership(
    organizationId: string,
    technicianId: string,
  ) {
    const membership = await this.prisma.staffMembership.findFirst({
      where: {
        organizationId,
        userId: technicianId,
        role: UserRole.THERAPIST,
        status: MembershipStatus.ACTIVE,
        user: { status: "ACTIVE" },
      },
      select: { user: { select: { displayName: true } } },
    });
    if (!membership) throw new NotFoundException("有效技师账号不存在");
    return membership;
  }

  private async ensureProfile(
    organizationId: string,
    technicianId: string,
    displayName: string,
  ): Promise<ProfileRecord> {
    const profile = await this.prisma.technicianProfile.upsert({
      where: { technicianId },
      create: {
        organizationId,
        technicianId,
        publicName: displayName,
      },
      update: {},
      include: { technician: { select: { displayName: true } } },
    });
    if (profile.organizationId !== organizationId) {
      throw new ConflictException("技师资料已归属其他组织，请由管理员核验账号归属");
    }
    return profile;
  }

  private async getAuthorizedProfile(
    principal: AuthPrincipal,
    organizationId: string,
    technicianId: string,
  ): Promise<ProfileRecord> {
    this.access.assertPermission(
      principal,
      "technicians.manage",
      organizationId,
    );
    const membership = await this.getTechnicianMembership(
      organizationId,
      technicianId,
    );
    return this.ensureProfile(
      organizationId,
      technicianId,
      membership.user.displayName,
    );
  }

  private profileUpdateData(
    input: TechnicianProfileUpdate,
  ): Prisma.TechnicianProfileUncheckedUpdateInput {
    const data: Prisma.TechnicianProfileUncheckedUpdateInput = {};
    if (input.publicName !== undefined) data.publicName = input.publicName;
    if (input.avatarUrl !== undefined) data.avatarUrl = input.avatarUrl;
    if (input.galleryUrls !== undefined) data.galleryUrls = input.galleryUrls;
    if (input.introduction !== undefined)
      data.introduction = input.introduction;
    if (input.specialties !== undefined) data.specialties = input.specialties;
    if (input.serviceYears !== undefined)
      data.serviceYears = input.serviceYears;
    if (input.certificates !== undefined)
      data.certificates = input.certificates;
    return data;
  }

  private async changeStatus(
    principal: AuthPrincipal,
    current: ProfileRecord,
    status: TechnicianProfileStatus,
    action: string,
    reviewed = false,
  ): Promise<ProfileRecord> {
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.technicianProfile.updateMany({
        where: { id: current.id, status: current.status },
        data: {
          status,
          rejectionReason: null,
          reviewedById: reviewed ? principal.userId : null,
          reviewedAt: reviewed ? new Date() : null,
        },
      });
      if (changed.count !== 1) {
        throw new ConflictException("技师资料审核状态已变化");
      }
      const updated = await tx.technicianProfile.findUniqueOrThrow({
        where: { id: current.id },
        include: { technician: { select: { displayName: true } } },
      });
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId: current.organizationId,
          action,
          resourceType: "TechnicianProfile",
          resourceId: current.id,
          metadata: { previousStatus: current.status, status },
        },
      });
      return updated;
    });
  }

  private assertProfileComplete(profile: ProfileRecord) {
    if (
      !profile.publicName.trim() ||
      !profile.avatarUrl ||
      !profile.introduction.trim() ||
      !this.stringArray(profile.specialties, "擅长项目").length
    ) {
      throw new ForbiddenException("公开昵称、头像、简介和擅长项目填写完整后才能提交");
    }
  }

  private async toProfile(
    profile: ProfileRecord,
    publicView: boolean,
  ): Promise<TechnicianProfile> {
    const [reviewStats, completedOrders, recentRows] = await Promise.all([
      this.prisma.technicianReview.aggregate({
        where: {
          organizationId: profile.organizationId,
          technicianId: profile.technicianId,
          status: TechnicianReviewStatus.PUBLISHED,
        },
        _avg: { rating: true },
        _count: { _all: true },
      }),
      this.prisma.order.count({
        where: {
          organizationId: profile.organizationId,
          therapistId: profile.technicianId,
          status: OrderStatus.COMPLETED,
        },
      }),
      this.prisma.technicianReview.findMany({
        where: {
          organizationId: profile.organizationId,
          technicianId: profile.technicianId,
          status: TechnicianReviewStatus.PUBLISHED,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 5,
      }),
    ]);
    return {
      technicianId: profile.technicianId,
      displayName: publicView ? profile.publicName : profile.technician.displayName,
      publicName: profile.publicName,
      avatarUrl: profile.avatarUrl,
      galleryUrls: this.stringArray(profile.galleryUrls, "相册"),
      introduction: profile.introduction,
      specialties: this.stringArray(profile.specialties, "擅长项目"),
      serviceYears: profile.serviceYears,
      certificates: this.stringArray(profile.certificates, "资质证书"),
      reviewSummary: {
        averageRating: reviewStats._avg.rating,
        reviewCount: reviewStats._count._all,
        completedOrders,
      },
      recentReviews: recentRows.map((row) => this.toReview(row)),
      status: profile.status,
      rejectionReason: publicView ? null : profile.rejectionReason,
      freeTravelFee: true,
      travelFeeFen: 0,
      updatedAt: profile.updatedAt.toISOString(),
    };
  }

  private toReview(row: {
    id: string;
    technicianId: string;
    rating: number;
    content: string;
    createdAt: Date;
  }): TechnicianReview {
    return {
      id: row.id,
      technicianId: row.technicianId,
      customerAlias: "已认证客户",
      rating: row.rating,
      content: row.content,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toAdminReview(row: {
    id: string;
    orderId: string;
    technicianId: string;
    rating: number;
    content: string;
    status: TechnicianReviewStatus;
    createdAt: Date;
    updatedAt: Date;
  }): AdminTechnicianReview {
    return {
      ...this.toReview(row),
      orderId: row.orderId,
      status: row.status,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private stringArray(value: Prisma.JsonValue, field: string): string[] {
    if (
      !Array.isArray(value) ||
      !value.every((entry) => typeof entry === "string")
    ) {
      throw new InternalServerErrorException(`${field}资料格式异常`);
    }
    return value;
  }
}
