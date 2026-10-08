import { ConflictException, ForbiddenException } from "@nestjs/common";
import {
  MembershipStatus,
  OrderStatus,
  TechnicianProfileStatus,
  TechnicianReviewStatus,
  UserRole,
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { TechniciansService } from "./technicians.service.js";

const technician: AuthPrincipal = {
  sessionId: "session-technician",
  userId: "technician-1",
  displayName: "内部实名",
  memberships: [{ organizationId: "org-1", role: UserRole.THERAPIST }],
};

const customer: AuthPrincipal = {
  sessionId: "session-customer",
  userId: "customer-1",
  displayName: "客户实名",
  memberships: [],
};

const admin: AuthPrincipal = {
  sessionId: "session-admin",
  userId: "admin-1",
  displayName: "运营管理员",
  memberships: [{ organizationId: "org-1", role: UserRole.OPERATOR }],
};

const profile = (overrides: Record<string, unknown> = {}) => ({
  id: "profile-1",
  organizationId: "org-1",
  technicianId: technician.userId,
  publicName: "公开昵称",
  avatarUrl: "https://cdn.example.com/avatar.jpg",
  galleryUrls: ["https://cdn.example.com/gallery.jpg"],
  introduction: "经过审核的专业服务介绍",
  specialties: ["肩颈舒缓"],
  serviceYears: 2,
  certificates: ["健康服务培训证明"],
  status: TechnicianProfileStatus.PUBLISHED,
  rejectionReason: null,
  reviewedById: "admin-1",
  reviewedAt: new Date("2026-10-08T01:00:00.000Z"),
  createdAt: new Date("2026-10-08T00:00:00.000Z"),
  updatedAt: new Date("2026-10-08T02:00:00.000Z"),
  technician: { displayName: technician.displayName },
  ...overrides,
});

function metrics() {
  return {
    technicianReview: {
      aggregate: vi.fn().mockResolvedValue({
        _avg: { rating: 4.8 },
        _count: { _all: 5 },
      }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    order: { count: vi.fn().mockResolvedValue(12) },
  };
}

describe("TechniciansService", () => {
  it("publishes only the public nickname, enforces zero travel fee, and scopes metrics to the profile organization", async () => {
    const scopedMetrics = metrics();
    const prisma = {
      technicianProfile: { findFirst: vi.fn().mockResolvedValue(profile()) },
      staffMembership: {
        findFirst: vi.fn().mockResolvedValue({ id: "membership-1" }),
      },
      ...scopedMetrics,
    };
    const service = new TechniciansService(prisma as never, {} as never);

    const result = await service.getPublic(technician.userId);

    expect(result.displayName).toBe("公开昵称");
    expect(result.displayName).not.toBe("内部实名");
    expect(result).toMatchObject({
      freeTravelFee: true,
      travelFeeFen: 0,
      reviewSummary: {
        averageRating: 4.8,
        reviewCount: 5,
        completedOrders: 12,
      },
    });
    expect(scopedMetrics.technicianReview.aggregate).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        technicianId: technician.userId,
        status: TechnicianReviewStatus.PUBLISHED,
      },
      _avg: { rating: true },
      _count: { _all: true },
    });
    expect(scopedMetrics.technicianReview.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: "org-1",
          technicianId: technician.userId,
          status: TechnicianReviewStatus.PUBLISHED,
        },
      }),
    );
    expect(scopedMetrics.order.count).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        therapistId: technician.userId,
        status: OrderStatus.COMPLETED,
      },
    });
  });

  it("excludes public reviews for the same technician id in another organization", async () => {
    const reviews = {
      findMany: vi.fn().mockImplementation(({ where }) =>
        Promise.resolve(
          where.organizationId === "org-1"
            ? []
            : [
                {
                  id: "leaked-review",
                  technicianId: technician.userId,
                  rating: 1,
                  content: "其他组织评价",
                  createdAt: new Date("2026-10-08T03:00:00.000Z"),
                },
              ],
        ),
      ),
    };
    const prisma = {
      technicianProfile: { findFirst: vi.fn().mockResolvedValue(profile()) },
      staffMembership: {
        findFirst: vi.fn().mockResolvedValue({ id: "membership-1" }),
      },
      technicianReview: reviews,
    };
    const service = new TechniciansService(prisma as never, {} as never);

    await expect(
      service.listPublicReviews(technician.userId),
    ).resolves.toEqual([]);
    expect(reviews.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: "org-1",
          technicianId: technician.userId,
          status: TechnicianReviewStatus.PUBLISHED,
        },
      }),
    );
  });

  it("saves a technician self edit as a draft and records an audit", async () => {
    const current = profile({ status: TechnicianProfileStatus.PUBLISHED });
    const updated = profile({
      publicName: "新公开昵称",
      status: TechnicianProfileStatus.DRAFT,
      reviewedById: null,
      reviewedAt: null,
    });
    const tx = {
      technicianProfile: { update: vi.fn().mockResolvedValue(updated) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      staffMembership: {
        findFirst: vi.fn().mockResolvedValue({ organizationId: "org-1" }),
      },
      technicianProfile: { upsert: vi.fn().mockResolvedValue(current) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
      ...metrics(),
    };
    const service = new TechniciansService(prisma as never, {} as never);

    await expect(
      service.updateOwnProfile(technician, { publicName: "新公开昵称" }),
    ).resolves.toMatchObject({
      displayName: technician.displayName,
      publicName: "新公开昵称",
      status: "DRAFT",
    });
    expect(tx.technicianProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: TechnicianProfileStatus.DRAFT,
          reviewedById: null,
          reviewedAt: null,
        }),
      }),
    );
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
  });

  it("does not submit incomplete or already approved profile content", async () => {
    const prisma = {
      staffMembership: {
        findFirst: vi.fn().mockResolvedValue({ organizationId: "org-1" }),
      },
      technicianProfile: {
        upsert: vi.fn().mockResolvedValue(
          profile({
            status: TechnicianProfileStatus.DRAFT,
            avatarUrl: null,
          }),
        ),
      },
    };
    const service = new TechniciansService(prisma as never, {} as never);
    await expect(service.submitOwnProfile(technician)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("moves a complete self profile from draft to pending review with audit evidence", async () => {
    const current = profile({ status: TechnicianProfileStatus.DRAFT });
    const pending = profile({ status: TechnicianProfileStatus.PENDING_REVIEW });
    const tx = {
      technicianProfile: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue(pending),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      staffMembership: {
        findFirst: vi.fn().mockResolvedValue({ organizationId: "org-1" }),
      },
      technicianProfile: { upsert: vi.fn().mockResolvedValue(current) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
      ...metrics(),
    };
    const service = new TechniciansService(prisma as never, {} as never);

    await expect(service.submitOwnProfile(technician)).resolves.toMatchObject({
      status: TechnicianProfileStatus.PENDING_REVIEW,
    });
    expect(tx.technicianProfile.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: current.id,
          status: TechnicianProfileStatus.DRAFT,
        },
        data: expect.objectContaining({
          status: TechnicianProfileStatus.PENDING_REVIEW,
        }),
      }),
    );
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
  });

  it("creates one review only from the customer's completed assigned order", async () => {
    const created = {
      id: "review-1",
      organizationId: "org-1",
      orderId: "order-1",
      customerId: customer.userId,
      technicianId: technician.userId,
      rating: 5,
      content: "服务认真周到",
      status: TechnicianReviewStatus.PENDING_REVIEW,
      createdAt: new Date("2026-10-08T04:00:00.000Z"),
      updatedAt: new Date("2026-10-08T04:00:00.000Z"),
    };
    const tx = {
      technicianReview: { create: vi.fn().mockResolvedValue(created) },
      orderEvent: { create: vi.fn().mockResolvedValue({}) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      outboxEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      order: {
        findUnique: vi.fn().mockResolvedValue({
          id: "order-1",
          organizationId: "org-1",
          customerId: customer.userId,
          therapistId: technician.userId,
          status: OrderStatus.COMPLETED,
          technicianReview: null,
        }),
      },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    const service = new TechniciansService(prisma as never, {} as never);

    await expect(
      service.createReview(customer, "order-1", {
        rating: 5,
        content: "服务认真周到",
      }),
    ).resolves.toMatchObject({
      id: "review-1",
      customerAlias: "已认证客户",
      rating: 5,
    });
    expect(tx.orderEvent.create).toHaveBeenCalledOnce();
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
    expect(tx.outboxEvent.create).toHaveBeenCalledOnce();
    expect(tx.technicianReview.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: TechnicianReviewStatus.PENDING_REVIEW,
        }),
      }),
    );
  });

  it("downgrades an admin-edited published profile until it is published again", async () => {
    const current = profile({ status: TechnicianProfileStatus.PUBLISHED });
    const approved = profile({
      publicName: "管理员修订昵称",
      status: TechnicianProfileStatus.APPROVED,
    });
    const access = { assertPermission: vi.fn() };
    const tx = {
      technicianProfile: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue(approved),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      staffMembership: {
        findFirst: vi.fn().mockResolvedValue({
          user: { displayName: technician.displayName },
        }),
      },
      technicianProfile: { upsert: vi.fn().mockResolvedValue(current) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
      ...metrics(),
    };
    const service = new TechniciansService(prisma as never, access as never);

    await expect(
      service.updateAdminProfile(admin, "org-1", technician.userId, {
        publicName: "管理员修订昵称",
      }),
    ).resolves.toMatchObject({
      publicName: "管理员修订昵称",
      status: TechnicianProfileStatus.APPROVED,
    });
    expect(tx.technicianProfile.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: current.id,
          status: TechnicianProfileStatus.PUBLISHED,
        },
        data: expect.objectContaining({
          publicName: "管理员修订昵称",
          status: TechnicianProfileStatus.APPROVED,
        }),
      }),
    );
  });

  it("publishes a pending review with scoped optimistic update and audit", async () => {
    const pending = {
      id: "review-1",
      organizationId: "org-1",
      orderId: "order-1",
      customerId: customer.userId,
      technicianId: technician.userId,
      rating: 5,
      content: "服务认真周到",
      status: TechnicianReviewStatus.PENDING_REVIEW,
      createdAt: new Date("2026-10-08T04:00:00.000Z"),
      updatedAt: new Date("2026-10-08T04:00:00.000Z"),
    };
    const published = {
      ...pending,
      status: TechnicianReviewStatus.PUBLISHED,
      updatedAt: new Date("2026-10-08T04:05:00.000Z"),
    };
    const access = { assertPermission: vi.fn() };
    const tx = {
      technicianReview: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue(published),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      outboxEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      staffMembership: {
        findFirst: vi.fn().mockResolvedValue({
          user: { displayName: technician.displayName },
        }),
      },
      technicianReview: { findUnique: vi.fn().mockResolvedValue(pending) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    const service = new TechniciansService(prisma as never, access as never);

    await expect(
      service.publishReview(
        admin,
        "org-1",
        technician.userId,
        pending.id,
      ),
    ).resolves.toMatchObject({
      id: pending.id,
      status: TechnicianReviewStatus.PUBLISHED,
    });
    expect(tx.technicianReview.updateMany).toHaveBeenCalledWith({
      where: {
        id: pending.id,
        organizationId: "org-1",
        technicianId: technician.userId,
        status: TechnicianReviewStatus.PENDING_REVIEW,
      },
      data: { status: TechnicianReviewStatus.PUBLISHED },
    });
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
    expect(tx.outboxEvent.create).toHaveBeenCalledOnce();
  });

  it("refuses to moderate a review outside the requested organization", async () => {
    const access = { assertPermission: vi.fn() };
    const prisma = {
      staffMembership: {
        findFirst: vi.fn().mockResolvedValue({
          user: { displayName: technician.displayName },
        }),
      },
      technicianReview: {
        findUnique: vi.fn().mockResolvedValue({
          id: "review-foreign",
          organizationId: "org-other",
          technicianId: technician.userId,
          status: TechnicianReviewStatus.PENDING_REVIEW,
        }),
      },
      $transaction: vi.fn(),
    };
    const service = new TechniciansService(prisma as never, access as never);

    await expect(
      service.hideReview(
        admin,
        "org-1",
        technician.userId,
        "review-foreign",
      ),
    ).rejects.toThrow("评价不存在");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects a review before the order is completed", async () => {
    const prisma = {
      order: {
        findUnique: vi.fn().mockResolvedValue({
          id: "order-1",
          organizationId: "org-1",
          customerId: customer.userId,
          therapistId: technician.userId,
          status: OrderStatus.ASSIGNED,
          technicianReview: null,
        }),
      },
    };
    const service = new TechniciansService(prisma as never, {} as never);
    await expect(
      service.createReview(customer, "order-1", {
        rating: 5,
        content: "尚未完成",
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("requires an active therapist membership before self editing", async () => {
    const prisma = {
      staffMembership: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const service = new TechniciansService(prisma as never, {} as never);
    await expect(service.getOwnProfile(technician)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.staffMembership.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          role: UserRole.THERAPIST,
          status: MembershipStatus.ACTIVE,
        }),
      }),
    );
  });

  it("does not expose a profile across organizations when memberships change", async () => {
    const prisma = {
      staffMembership: {
        findFirst: vi.fn().mockResolvedValue({ organizationId: "org-2" }),
      },
      technicianProfile: {
        upsert: vi.fn().mockResolvedValue(profile({ organizationId: "org-1" })),
      },
    };
    const service = new TechniciansService(prisma as never, {} as never);

    await expect(service.getOwnProfile(technician)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
