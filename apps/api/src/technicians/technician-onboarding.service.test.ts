import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { TechniciansService } from "./technicians.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";

const applicant: AuthPrincipal = {
  sessionId: "session",
  userId: "applicant",
  displayName: "微信用户",
  memberships: [],
  authChannel: "WECHAT_MINIAPP",
  authProvider: "wechat",
  phoneVerified: true,
};
const administrator: AuthPrincipal = {
  sessionId: "admin-session",
  userId: "admin",
  displayName: "管理员",
  memberships: [{ organizationId: "org", role: "OPERATOR" }],
};
const profile = (overrides = {}) => ({
  id: "profile",
  organizationId: "org",
  technicianId: "applicant",
  publicName: "",
  ageRange: null,
  avatarUrl: "https://fixture.invalid/avatar",
  galleryUrls: [],
  introduction: "本人填写的服务介绍",
  specialties: ["肩颈舒缓"],
  serviceYears: null,
  certificates: [],
  status: "PENDING_REVIEW",
  selfRegistered: true,
  registrationChannel: "WECHAT_MINIAPP",
  realNameEncrypted: "TEST-ENCRYPTED-NAME",
  serviceCity: "郑州市",
  serviceAreas: ["金水区"],
  availableTimeSlots: ["MON:09:00-18:00"],
  serviceIds: ["service-1"],
  rejectionReason: null,
  version: 4,
  updatedAt: new Date(),
  technician: { displayName: "微信用户" },
  ...overrides,
});
function fixture() {
  const current = profile();
  const tx = {
    $queryRaw: vi.fn(),
    user: {
      findUnique: vi.fn().mockResolvedValue({
        status: "ACTIVE",
        phoneEncrypted: "TEST-ENCRYPTED",
        phoneVerifiedAt: new Date(),
        identities: [{ id: "wechat-identity" }],
      }),
    },
    organization: { findMany: vi.fn().mockResolvedValue([{ id: "org" }]) },
    staffMembership: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: "membership" }),
    },
    technicianProfile: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(current),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi
        .fn()
        .mockResolvedValue({ ...current, status: "APPROVED", version: 5 }),
    },
    auditLog: { create: vi.fn() },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) =>
      callback(tx),
    ),
    technicianProfile: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(current),
      findMany: vi.fn().mockResolvedValue([current]),
      upsert: vi.fn().mockResolvedValue(current),
    },
    technicianPhoto: { findFirst: vi.fn().mockResolvedValue({ id: "photo" }) },
    technicianIdentityDocument: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ kind: "ID_FRONT" }, { kind: "ID_BACK" }]),
    },
    service: { count: vi.fn().mockResolvedValue(1) },
    staffMembership: { findFirst: vi.fn().mockResolvedValue(null) },
    technicianReview: {
      aggregate: vi
        .fn()
        .mockResolvedValue({ _avg: { rating: null }, _count: { _all: 0 } }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    order: { count: vi.fn().mockResolvedValue(0) },
  };
  const access = { assertPermission: vi.fn() };
  return {
    current,
    tx,
    prisma,
    access,
    service: new TechniciansService(prisma as never, access as never),
  };
}
describe("微信自主入驻审核", () => {
  it.each([
    { authChannel: "MOCK", authProvider: "mock" },
    { authChannel: "WECHAT_MINIAPP", authProvider: "mock" },
    { phoneVerified: false },
  ])(
    "rejects untrusted or unverified registration before database writes: %j",
    async (fields) => {
      const f = fixture();
      await expect(
        f.service.register({ ...applicant, ...fields }),
      ).rejects.toThrow(ForbiddenException);
      expect(f.prisma.$transaction).not.toHaveBeenCalled();
    },
  );
  it("creates only an owner draft with blank optional fields, never membership", async () => {
    const f = fixture();
    await expect(f.service.register(applicant)).resolves.toMatchObject({
      canEnterWorkbench: false,
    });
    expect(f.tx.technicianProfile.create).toHaveBeenCalledWith({
      data: {
        organizationId: "org",
        technicianId: "applicant",
        publicName: "",
        selfRegistered: true,
        registrationChannel: "WECHAT_MINIAPP",
        status: "DRAFT",
      },
    });
    expect(f.tx.staffMembership.create).not.toHaveBeenCalled();
    expect(f.tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: { phoneVerified: true, membershipGranted: false },
        }),
      }),
    );
  });
  it("rechecks stored identity and verified phone even if principal says verified", async () => {
    const f = fixture();
    f.tx.user.findUnique.mockResolvedValue(null as never);
    await expect(f.service.register(applicant)).rejects.toThrow(
      "本人微信和手机号",
    );
    expect(f.tx.technicianProfile.create).not.toHaveBeenCalled();
  });
  it("does not duplicate existing registrations or membership", async () => {
    const f = fixture();
    f.tx.technicianProfile.findUnique.mockResolvedValue(f.current as never);
    await f.service.register(applicant);
    expect(f.tx.organization.findMany).not.toHaveBeenCalled();
    expect(f.tx.technicianProfile.create).not.toHaveBeenCalled();
    expect(f.tx.staffMembership.create).not.toHaveBeenCalled();
  });
  it.each([
    { organizations: [] },
    { organizations: [{ id: "org" }, { id: "other-org" }] },
  ])(
    "fails closed instead of selecting an ambiguous tenant: %j",
    async ({ organizations }) => {
      const f = fixture();
      f.tx.organization.findMany.mockResolvedValue(organizations);
      await expect(f.service.register(applicant)).rejects.toThrow(
        "组织尚未明确",
      );
      expect(f.tx.technicianProfile.create).not.toHaveBeenCalled();
    },
  );
  it("pending applicants can edit their own profile but cannot enter workbench", async () => {
    const f = fixture();
    f.prisma.technicianProfile.findUnique.mockResolvedValue(f.current as never);
    await expect(f.service.onboarding(applicant)).resolves.toMatchObject({
      canEnterWorkbench: false,
      profile: { status: "PENDING_REVIEW", version: 4 },
    });
    await expect(f.service.getOwnProfile(applicant)).resolves.toMatchObject({
      technicianId: "applicant",
    });
    expect(f.prisma.technicianProfile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          technicianId: "applicant",
          selfRegistered: true,
          technician: { status: "ACTIVE" },
        },
      }),
    );
  });
  it("admin can privately preview a pending applicant photo without granting membership", async () => {
    const f = fixture();
    await expect(
      f.service.getAdminPhoto(administrator, "org", "applicant", "photo"),
    ).resolves.toHaveProperty("id", "photo");
    expect(f.prisma.technicianPhoto.findFirst).toHaveBeenCalledWith({
      where: {
        id: "photo",
        profile: { organizationId: "org", technicianId: "applicant" },
      },
    });
    expect(f.tx.staffMembership.create).not.toHaveBeenCalled();
  });
  it("another organization is denied before loading applications or photos", async () => {
    const f = fixture();
    f.access.assertPermission.mockImplementation(() => {
      throw new ForbiddenException();
    });
    await expect(
      f.service.listApplications(administrator, "other"),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      f.service.getAdminPhoto(administrator, "other", "applicant", "photo"),
    ).rejects.toThrow(ForbiddenException);
    expect(f.prisma.technicianProfile.findMany).not.toHaveBeenCalled();
    expect(f.prisma.technicianPhoto.findFirst).not.toHaveBeenCalled();
  });
  it("requires the reviewed version and atomically binds identity only on approval", async () => {
    const f = fixture();
    await expect(
      f.service.approve(administrator, "org", "applicant", 3),
    ).rejects.toThrow("资料已更新");
    expect(f.tx.staffMembership.create).not.toHaveBeenCalled();
    await expect(
      f.service.approve(administrator, "org", "applicant", 4),
    ).resolves.toMatchObject({ status: "APPROVED" });
    expect(f.tx.staffMembership.create).toHaveBeenCalledWith({
      data: {
        userId: "applicant",
        organizationId: "org",
        role: "THERAPIST",
        status: "ACTIVE",
      },
    });
    expect(f.tx.technicianProfile.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "profile", status: "PENDING_REVIEW", version: 4 },
      }),
    );
  });
  it.each([
    "submitAdminProfile",
    "submitOwnProfile",
    "approve",
    "publish",
  ] as const)(
    "native %s cannot bypass complete private application material through older profile routes",
    async (action) => {
      const f = fixture();
      f.current.status =
        action === "approve"
          ? "PENDING_REVIEW"
          : action === "publish"
            ? "APPROVED"
            : "DRAFT";
      if (action === "submitOwnProfile")
        f.prisma.staffMembership.findFirst.mockResolvedValue({
          organizationId: "org",
        } as never);
      f.prisma.technicianIdentityDocument.findMany.mockResolvedValue([
        { kind: "ID_FRONT" },
      ]);
      const request =
        action === "submitOwnProfile"
          ? f.service.submitOwnProfile(applicant)
          : action === "approve"
            ? f.service.approve(administrator, "org", "applicant", 4)
            : f.service[action](administrator, "org", "applicant");
      await expect(request).rejects.toThrow("完整入驻资料");
      expect(f.prisma.$transaction).not.toHaveBeenCalled();
      expect(f.tx.staffMembership.create).not.toHaveBeenCalled();
      expect(f.tx.technicianProfile.updateMany).not.toHaveBeenCalled();
    },
  );
  it.each(["realNameEncrypted", "serviceCity"] as const)(
    "native approval requires %s even when public portrait information is complete",
    async (field) => {
      const f = fixture();
      f.current[field] = "";
      await expect(
        f.service.approve(administrator, "org", "applicant", 4),
      ).rejects.toThrow("完整入驻资料");
      expect(f.prisma.$transaction).not.toHaveBeenCalled();
    },
  );
  it("native approval rechecks that selected services are still published", async () => {
    const f = fixture();
    f.prisma.service.count.mockResolvedValue(0);
    await expect(
      f.service.approve(administrator, "org", "applicant", 4),
    ).rejects.toThrow("擅长项目状态已变化");
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
  it.each([
    { organizationId: "org", status: "SUSPENDED" },
    { organizationId: "other", status: "ACTIVE" },
  ])(
    "approval cannot restore suspended access or transfer organization: %j",
    async (membership) => {
      const f = fixture();
      f.tx.staffMembership.findMany.mockResolvedValue([membership] as never);
      await expect(
        f.service.approve(administrator, "org", "applicant", 4),
      ).rejects.toThrow("不可通过资料审核");
      expect(f.tx.staffMembership.create).not.toHaveBeenCalled();
      expect(f.tx.technicianProfile.updateMany).not.toHaveBeenCalled();
    },
  );
  it("rejects stale concurrent review inside the transaction", async () => {
    const f = fixture();
    f.tx.technicianProfile.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      f.service.approve(administrator, "org", "applicant", 4),
    ).rejects.toThrow("状态已变化");
    expect(f.tx.auditLog.create).not.toHaveBeenCalled();
  });
  it("rejection records the reason without granting access", async () => {
    const f = fixture();
    f.tx.technicianProfile.findUniqueOrThrow.mockResolvedValue(
      profile({
        status: "REJECTED",
        rejectionReason: "请补充本人头像",
      }) as never,
    );
    await expect(
      f.service.reject(administrator, "org", "applicant", "请补充本人头像", 4),
    ).resolves.toMatchObject({
      status: "REJECTED",
      rejectionReason: "请补充本人头像",
    });
    expect(f.tx.staffMembership.create).not.toHaveBeenCalled();
    expect(f.tx.technicianProfile.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ rejectionReason: "请补充本人头像" }),
      }),
    );
  });
  it("approval alone does not allow login when membership has been suspended", async () => {
    const f = fixture();
    f.prisma.technicianProfile.findUnique.mockResolvedValue(
      profile({ status: "APPROVED" }) as never,
    );
    await expect(f.service.onboarding(applicant)).resolves.toMatchObject({
      canEnterWorkbench: false,
    });
    f.prisma.staffMembership.findFirst.mockResolvedValue({
      id: "active",
    } as never);
    await expect(f.service.onboarding(applicant)).resolves.toMatchObject({
      canEnterWorkbench: true,
    });
  });
});
