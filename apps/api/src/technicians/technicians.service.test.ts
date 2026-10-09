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
  it.each(["approve", "publish"] as const)("rejects %s if another content write changes the version during review", async (action) => {
    const current = profile({ status: action === "approve" ? TechnicianProfileStatus.PENDING_REVIEW : TechnicianProfileStatus.APPROVED, version: 4 });
    const tx = { technicianProfile: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), findUniqueOrThrow: vi.fn() }, auditLog: { create: vi.fn() } };
    const prisma = { staffMembership: { findFirst: vi.fn().mockResolvedValue({ user: { displayName: "private" } }) }, technicianProfile: { upsert: vi.fn().mockResolvedValue(current) }, $transaction: vi.fn((callback) => callback(tx)) };
    const access = { assertPermission: vi.fn() };
    await expect(new TechniciansService(prisma as never, access as never)[action](admin, "org-1", technician.userId)).rejects.toThrow("内容或审核状态已变化");
    expect(tx.technicianProfile.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: current.id, status: current.status, version: 4 }, data: expect.objectContaining({ version: { increment: 1 } }) }));
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("allows a scoped admin to submit complete photo-first draft with blank optional fields", async () => {
    const current = profile({ publicName: "", ageRange: null, status: TechnicianProfileStatus.DRAFT, version: 2 });
    const pending = { ...current, status: TechnicianProfileStatus.PENDING_REVIEW, version: 3 };
    const tx = { technicianProfile: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUniqueOrThrow: vi.fn().mockResolvedValue(pending) }, auditLog: { create: vi.fn() } };
    const prisma = { staffMembership: { findFirst: vi.fn().mockResolvedValue({ user: { displayName: "private" } }) }, technicianProfile: { upsert: vi.fn().mockResolvedValue(current) }, $transaction: vi.fn((callback) => callback(tx)), ...metrics() };
    const access = { assertPermission: vi.fn() };
    await expect(new TechniciansService(prisma as never, access as never).submitAdminProfile(admin, "org-1", technician.userId)).resolves.toMatchObject({ publicName: "", ageRange: null, status: "PENDING_REVIEW" });
    expect(access.assertPermission).toHaveBeenCalledWith(admin, "technicians.manage", "org-1");
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "TECHNICIAN_PROFILE_ADMIN_SUBMITTED" }) }));
  });

  it.each([TechnicianProfileStatus.PENDING_REVIEW, TechnicianProfileStatus.APPROVED, TechnicianProfileStatus.PUBLISHED])("invalidates %s review on admin photo upload and requires fresh submission", async (status) => {
    const current = profile({ status, version: 9 });
    const changed = { ...current, status: TechnicianProfileStatus.DRAFT, version: 10 };
    const tx = { $queryRaw: vi.fn(), technicianProfile: { findUniqueOrThrow: vi.fn().mockResolvedValue(current), update: vi.fn().mockResolvedValue(changed) }, technicianPhoto: { findUnique: vi.fn().mockResolvedValue({ id: "photo-1", width: 1, height: 1 }) }, auditLog: { create: vi.fn() } };
    const prisma = { staffMembership: { findFirst: vi.fn().mockResolvedValue({ user: { displayName: "private" } }) }, technicianProfile: { upsert: vi.fn().mockResolvedValue(current) }, $transaction: vi.fn((callback) => callback(tx)), ...metrics() };
    const photos = { publicUrl: vi.fn(() => "https://api.example.com/v1/technicians/technician-1/photos/photo-1"), normalize: vi.fn().mockResolvedValue({ digest: "digest", content: new Uint8Array([1]), width: 1, height: 1 }) };
    await expect(new TechniciansService(prisma as never, { assertPermission: vi.fn() } as never, photos as never).uploadAdminPhoto(admin, "org-1", technician.userId, { kind: "AVATAR", base64: "AAAA", authorized: true })).resolves.toMatchObject({ profile: { status: "DRAFT" } });
    expect(tx.technicianProfile.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "DRAFT", version: { increment: 1 }, reviewedById: null, reviewedAt: null }) }));
  });

  it("keeps optional public name/age empty without leaking an internal identity", async () => {
    const prisma = { technicianProfile: { findFirst: vi.fn().mockResolvedValue(profile({ publicName: "", ageRange: null })) }, staffMembership: { findFirst: vi.fn().mockResolvedValue({ id: "member" }) }, ...metrics() };
    const result = await new TechniciansService(prisma as never, {} as never).getPublic(technician.userId);
    expect(result.publicName).toBe(""); expect(result.displayName).toBe(""); expect(result.ageRange).toBeNull();
  });

  it("does not require optional name/age when submitting a real photo, introduction and specialty", async () => {
    const current = profile({ publicName: "", ageRange: null, status: TechnicianProfileStatus.DRAFT });
    const updated = { ...current, status: TechnicianProfileStatus.PENDING_REVIEW };
    const tx = { technicianProfile: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUniqueOrThrow: vi.fn().mockResolvedValue(updated) }, auditLog: { create: vi.fn() } };
    const prisma = { staffMembership: { findFirst: vi.fn().mockResolvedValue({ organizationId: "org-1" }) }, technicianProfile: { upsert: vi.fn().mockResolvedValue(current) }, $transaction: vi.fn((callback) => callback(tx)), ...metrics() };
    await expect(new TechniciansService(prisma as never, {} as never).submitOwnProfile(technician)).resolves.toMatchObject({ publicName: "", ageRange: null, status: "PENDING_REVIEW" });
  });

  it("rejects a customer's photo upload before decoding any bytes", async () => {
    const normalize = vi.fn();
    const prisma = { staffMembership: { findFirst: vi.fn().mockResolvedValue(null) } };
    const photos = { normalize, publicUrl: vi.fn() };
    await expect(new TechniciansService(prisma as never, {} as never, photos as never).uploadOwnPhoto(customer, { kind: "AVATAR", base64: "AAAA", authorized: true })).rejects.toThrow(ForbiddenException);
    expect(normalize).not.toHaveBeenCalled();
  });

  it("prevents another-organization admin from uploading a technician's photo", async () => {
    const prisma = { staffMembership: { findFirst: vi.fn() } };
    const access = { assertPermission: vi.fn(() => { throw new ForbiddenException("cross organization"); }) };
    const photos = { normalize: vi.fn(), publicUrl: vi.fn() };
    await expect(new TechniciansService(prisma as never, access as never, photos as never).uploadAdminPhoto(admin, "org-other", technician.userId, { kind: "AVATAR", base64: "AAAA", authorized: true })).rejects.toThrow(ForbiddenException);
    expect(prisma.staffMembership.findFirst).not.toHaveBeenCalled(); expect(photos.normalize).not.toHaveBeenCalled();
  });

  it("only serves published photos currently referenced by the same profile", async () => {
    const photoId = "photo-1";
    const current = profile({ avatarUrl: `https://api.example.com/v1/technicians/${technician.userId}/photos/${photoId}` });
    const prisma = { technicianProfile: { findFirst: vi.fn().mockResolvedValue(current) }, technicianPhoto: { findFirst: vi.fn().mockResolvedValue({ id: photoId, profileId: current.id, content: new Uint8Array([1]) }) }, staffMembership: { findFirst: vi.fn().mockResolvedValue({ id: "membership-1" }) } };
    const service = new TechniciansService(prisma as never, {} as never);
    await expect(service.getPublicPhoto(technician.userId, photoId)).resolves.toHaveProperty("id", photoId);
    current.avatarUrl = "https://cdn.example.com/changed.jpg";
    await expect(service.getPublicPhoto(technician.userId, photoId)).rejects.toThrow("照片未公开");
    expect(prisma.technicianPhoto.findFirst).toHaveBeenCalledWith({ where: { id: photoId, profileId: "profile-1" } });
  });

  it("scope-locks private preview reads to owner organization and technician identity", async () => {
    const prisma = { staffMembership: { findFirst: vi.fn().mockResolvedValue({ organizationId: "org-1" }) }, technicianPhoto: { findFirst: vi.fn().mockResolvedValue(null) } };
    await expect(new TechniciansService(prisma as never, {} as never).getOwnPhoto(technician, "someone-elses-photo")).rejects.toThrow("本人照片不存在");
    expect(prisma.technicianPhoto.findFirst).toHaveBeenCalledWith({ where: { id: "someone-elses-photo", profile: { organizationId: "org-1", technicianId: technician.userId } } });
  });

  it("locks the profile, enforces24 stored images and does not create any oversized gallery", async () => {
    const current = profile();
    const tx = { $queryRaw: vi.fn(), technicianProfile: { findUniqueOrThrow: vi.fn().mockResolvedValue(current) }, technicianPhoto: { findUnique: vi.fn().mockResolvedValue(null), count: vi.fn().mockResolvedValue(24), create: vi.fn() } };
    const prisma = { staffMembership: { findFirst: vi.fn().mockResolvedValue({ organizationId: "org-1" }) }, technicianProfile: { upsert: vi.fn().mockResolvedValue(current) }, $transaction: vi.fn((callback) => callback(tx)) };
    const photos = { publicUrl: vi.fn(() => "https://api.example.com/v1/technicians/technician-1/photos/1"), normalize: vi.fn().mockResolvedValue({ digest: "digest", content: new Uint8Array([1]), width: 1, height: 1 }) };
    await expect(new TechniciansService(prisma as never, {} as never, photos as never).uploadOwnPhoto(technician, { kind: "GALLERY", base64: "AAAA", authorized: true })).rejects.toThrow("24张上限");
    expect(tx.$queryRaw).toHaveBeenCalledOnce(); expect(tx.technicianPhoto.create).not.toHaveBeenCalled();
  });

  it("deduplicates bytes, clears review state and syncs a self-upload without auto-publishing", async () => {
    const current = profile();
    const url = "https://api.example.com/v1/technicians/technician-1/photos/photo-1";
    const changed = { ...current, avatarUrl: url, status: TechnicianProfileStatus.DRAFT };
    const tx = { $queryRaw: vi.fn(), technicianProfile: { findUniqueOrThrow: vi.fn().mockResolvedValue(current), update: vi.fn().mockResolvedValue(changed) }, technicianPhoto: { findUnique: vi.fn().mockResolvedValue({ id: "photo-1", width: 100, height: 200 }), count: vi.fn(), create: vi.fn() }, auditLog: { create: vi.fn() } };
    const prisma = { staffMembership: { findFirst: vi.fn().mockResolvedValue({ organizationId: "org-1" }) }, technicianProfile: { upsert: vi.fn().mockResolvedValue(current) }, $transaction: vi.fn((callback) => callback(tx)), ...metrics() };
    const photos = { publicUrl: vi.fn(() => url), normalize: vi.fn().mockResolvedValue({ digest: "digest", content: new Uint8Array([1]), width: 100, height: 200 }) };
    const result = await new TechniciansService(prisma as never, {} as never, photos as never).uploadOwnPhoto(technician, { kind: "AVATAR", base64: "AAAA", authorized: true });
    expect(result).toMatchObject({ photoId: "photo-1", publicUrl: url, profile: { status: "DRAFT", avatarUrl: url } });
    expect(tx.technicianPhoto.create).not.toHaveBeenCalled();
    expect(tx.technicianProfile.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "DRAFT", reviewedById: null, reviewedAt: null }) }));
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "TECHNICIAN_PHOTO_SELF_UPLOADED" }) }));
  });

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
          version: 0,
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

  it("invalidates admin-edited published profile review until it is submitted and reviewed again", async () => {
    const current = profile({ status: TechnicianProfileStatus.PUBLISHED });
    const approved = profile({
      publicName: "管理员修订昵称",
      status: TechnicianProfileStatus.DRAFT,
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
      status: TechnicianProfileStatus.DRAFT,
    });
    expect(tx.technicianProfile.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: current.id,
          status: TechnicianProfileStatus.PUBLISHED,
          version: 0,
        },
        data: expect.objectContaining({
          publicName: "管理员修订昵称",
          status: TechnicianProfileStatus.DRAFT,
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
