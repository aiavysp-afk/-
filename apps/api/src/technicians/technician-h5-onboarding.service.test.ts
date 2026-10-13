import { ForbiddenException } from "@nestjs/common";
import { TechnicianIdentityDocumentKind } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { TechniciansService } from "./technicians.service.js";

const h5Applicant: AuthPrincipal = {
  sessionId: "session",
  userId: "applicant",
  displayName: "微信用户",
  memberships: [],
  authChannel: "WECHAT_H5",
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
  version: 3,
  selfRegistered: true,
  registrationChannel: "WECHAT_H5",
  realNameEncrypted: "encrypted-real-name",
  serviceCity: "郑州市",
  serviceAreas: ["金水区"],
  availableTimeSlots: ["MON:09:00-18:00"],
  serviceIds: ["service-1"],
  avatarUrl: "https://api.mtsc.top/v1/technicians/applicant/photos/avatar",
  galleryUrls: [],
  introduction: "专注肩颈放松与经络调理多年。",
  specialties: ["肩颈舒缓"],
  serviceYears: null,
  certificates: [],
  status: "DRAFT",
  rejectionReason: null,
  updatedAt: new Date("2026-10-12T08:00:00.000Z"),
  technician: { displayName: "微信用户" },
  ...overrides,
});

function fixture() {
  const current = profile();
  const documentFindMany = vi
    .fn()
    .mockResolvedValue([{ kind: TechnicianIdentityDocumentKind.ID_FRONT }]);
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    technicianIdentityDocument: {
      upsert: vi.fn().mockResolvedValue({ id: "document" }),
      findUnique: vi.fn().mockResolvedValue({
        id: "document",
        contentEncrypted: "encrypted-document",
      }),
    },
    technicianProfile: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        id: "profile",
        technicianId: "applicant",
        selfRegistered: true,
        status: "DRAFT",
        version: 3,
        galleryUrls: [],
      }),
      update: vi.fn().mockResolvedValue({ id: "profile" }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    technicianPhoto: {
      findUnique: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit" }) },
  };
  const prisma = {
    technicianReview: {
      aggregate: vi
        .fn()
        .mockResolvedValue({ _avg: { rating: null }, _count: { _all: 0 } }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    order: { count: vi.fn().mockResolvedValue(0) },
    technicianProfile: {
      findFirst: vi.fn().mockResolvedValue(current),
    },
    technicianIdentityDocument: { findMany: documentFindMany },
    staffMembership: { findFirst: vi.fn().mockResolvedValue(null) },
    service: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ id: "service-1", name: "肩颈舒缓" }]),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({
        phoneEncrypted: "encrypted-phone",
        phoneVerifiedAt: new Date(),
      }),
    },
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  const access = { assertPermission: vi.fn() };
  const photos = {
    publicUrl: vi.fn(
      (technicianId: string, photoId: string) =>
        `https://api.mtsc.top/v1/technicians/${technicianId}/photos/${photoId}`,
    ),
    normalize: vi.fn().mockResolvedValue({
      content: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      width: 1200,
      height: 800,
      digest: "sha256-digest",
    }),
  };
  const crypto = {
    encryptScoped: vi.fn().mockReturnValue("encrypted-document"),
    decryptScoped: vi.fn((purpose: string) =>
      purpose.startsWith("technician-real-name:")
        ? "张三"
        : Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"),
    ),
    decrypt: vi.fn().mockReturnValue("13800138000"),
  };
  return {
    current,
    tx,
    prisma,
    access,
    photos,
    crypto,
    service: new TechniciansService(
      prisma as never,
      access as never,
      photos as never,
      crypto as never,
      undefined,
    ),
  };
}

describe("技师H5入驻私密资料", () => {
  const miniappApplicant = { ...h5Applicant, authChannel: "WECHAT_MINIAPP" };

  it("verified native applicants can upload portraits before receiving any therapist membership", async () => {
    const f = fixture();
    f.tx.technicianPhoto.findUnique.mockResolvedValue(null as never);
    f.tx.technicianPhoto.count.mockResolvedValue(0 as never);
    f.tx.technicianPhoto.create.mockResolvedValue({ id: "photo" } as never);
    f.tx.technicianProfile.update.mockResolvedValue(
      profile({ registrationChannel: "WECHAT_MINIAPP" }) as never,
    );
    const result = await f.service.uploadMiniappApplicationPhoto(
      miniappApplicant,
      { kind: "AVATAR", contentBase64: "AAAA", consentConfirmed: true },
    );
    expect(result.application).toMatchObject({
      status: "DRAFT",
      hasIdFront: true,
    });
    expect(f.prisma.staffMembership.findFirst).not.toHaveBeenCalled();
    expect(f.prisma.technicianProfile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          technicianId: "applicant",
          selfRegistered: true,
          technician: { status: "ACTIVE" },
        },
      }),
    );
    expect(f.tx.technicianPhoto.create).toHaveBeenCalled();
  });

  it("native identity uploads use the encrypted private document table, never the portrait table", async () => {
    const f = fixture();
    const result = await f.service.uploadMiniappIdentityDocument(
      miniappApplicant,
      { kind: "ID_FRONT", contentBase64: "AAAA" },
    );
    expect(result.application?.hasIdFront).toBe(true);
    expect(f.tx.technicianIdentityDocument.upsert).toHaveBeenCalled();
    expect(f.tx.technicianPhoto.create).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("encrypted-document");
  });

  it.each([
    { ...miniappApplicant, phoneVerified: false },
    { ...miniappApplicant, authProvider: "mock" },
    { ...miniappApplicant, authChannel: "PASSWORD" },
    h5Applicant,
  ])(
    "native upload denies incorrect identity or unverified phone before reading photos: %j",
    async (principal) => {
      const f = fixture();
      await expect(
        f.service.uploadMiniappIdentityDocument(principal, {
          kind: "ID_FRONT",
          contentBase64: "AAAA",
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(f.photos.normalize).not.toHaveBeenCalled();
      expect(f.prisma.technicianProfile.findFirst).not.toHaveBeenCalled();
    },
  );

  it("H5-only endpoints continue to reject native sessions", async () => {
    const f = fixture();
    await expect(
      f.service.h5OnboardingStatus(miniappApplicant),
    ).rejects.toThrow(ForbiddenException);
    expect(f.prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("native submitted applications are locked before upload or profile modification", async () => {
    const f = fixture();
    f.prisma.technicianProfile.findFirst.mockResolvedValue(
      profile({ status: "PENDING_REVIEW" }),
    );
    await expect(
      f.service.uploadMiniappIdentityDocument(miniappApplicant, {
        kind: "ID_FRONT",
        contentBase64: "AAAA",
      }),
    ).rejects.toThrow("已提交审核");
    expect(f.photos.normalize).not.toHaveBeenCalled();
  });

  it("native submission rejects missing ID back without creating approval or changing status", async () => {
    const f = fixture();
    await expect(
      f.service.submitMiniappApplication(miniappApplicant),
    ).rejects.toThrow("身份证正反面");
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("native full profile saves validated catalog services and scoped encrypted real name", async () => {
    const f = fixture();
    const result = await f.service.updateMiniappApplication(miniappApplicant, {
      realName: "张三",
      serviceCity: "郑州市",
      serviceAreas: ["金水区"],
      availableTimeSlots: ["MON:09:00-18:00"],
      bio: "专注肩颈放松与经络调理多年。",
      serviceIds: ["service-1"],
    });
    expect(f.crypto.encryptScoped).toHaveBeenCalledWith(
      "technician-real-name:profile",
      "张三",
    );
    expect(f.tx.technicianProfile.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          serviceIds: ["service-1"],
          specialties: ["肩颈舒缓"],
          realNameEncrypted: "encrypted-document",
        }),
      }),
    );
    expect(result.application?.realName).toBe("张三");
    expect(JSON.stringify(f.tx.auditLog.create.mock.calls)).not.toContain(
      "张三",
    );
  });

  it("allows an existing self-registered miniapp profile to resume through H5", async () => {
    const f = fixture();
    f.prisma.technicianProfile.findFirst.mockResolvedValue(
      profile({
        registrationChannel: "WECHAT_MINIAPP",
        status: "PENDING_REVIEW",
      }),
    );

    await expect(
      f.service.h5OnboardingStatus(h5Applicant),
    ).resolves.toMatchObject({
      stage: "PENDING_REVIEW",
      phoneMasked: "138****8000",
      application: {
        realName: "张三",
        hasIdFront: true,
        hasIdBack: false,
      },
    });
    expect(f.prisma.technicianProfile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.not.objectContaining({
          registrationChannel: "WECHAT_H5",
        }),
      }),
    );
  });

  it("normalizes then encrypts ID images into the private document table", async () => {
    const f = fixture();
    const raw = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");

    const result = await f.service.uploadH5IdentityDocument(h5Applicant, {
      kind: "ID_FRONT",
      contentBase64: raw,
    });

    expect(f.photos.normalize).toHaveBeenCalledWith(raw);
    expect(f.crypto.encryptScoped).toHaveBeenCalledWith(
      "technician-identity-document:profile:ID_FRONT",
      raw,
    );
    expect(f.tx.technicianIdentityDocument.upsert).toHaveBeenCalledWith({
      where: {
        profileId_kind: {
          profileId: "profile",
          kind: TechnicianIdentityDocumentKind.ID_FRONT,
        },
      },
      create: expect.objectContaining({
        profileId: "profile",
        kind: TechnicianIdentityDocumentKind.ID_FRONT,
        contentEncrypted: "encrypted-document",
        digest: "sha256-digest",
      }),
      update: expect.objectContaining({
        contentEncrypted: "encrypted-document",
        digest: "sha256-digest",
      }),
    });
    expect(JSON.stringify(f.tx.auditLog.create.mock.calls)).not.toContain(raw);
    expect(result.application).toMatchObject({
      hasIdFront: true,
      hasIdBack: false,
    });
    expect(result.application).not.toHaveProperty("identityDocumentUrl");
    expect(JSON.stringify(result)).not.toContain("encrypted-document");
  });

  it.each(["profile", "document", "photo"] as const)(
    "rolls back a stale %s write if submission wins the race",
    async (operation) => {
      const f = fixture();
      f.tx.technicianProfile.findUniqueOrThrow.mockResolvedValue({
        id: "profile",
        technicianId: "applicant",
        selfRegistered: true,
        status: "PENDING_REVIEW",
        version: 4,
        galleryUrls: [],
      });
      const raw = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");

      const request =
        operation === "profile"
          ? f.service.updateH5Profile(h5Applicant, {
              realName: "张三",
              serviceCity: "郑州市",
              serviceAreas: ["金水区"],
              availableTimeSlots: ["MON:09:00-18:00"],
              bio: "专注肩颈放松与经络调理多年。",
              serviceIds: ["service-1"],
            })
          : operation === "document"
            ? f.service.uploadH5IdentityDocument(h5Applicant, {
                kind: "ID_FRONT",
                contentBase64: raw,
              })
            : f.service.uploadH5Photo(h5Applicant, {
                kind: "AVATAR",
                contentBase64: raw,
                consentConfirmed: true,
              });

      await expect(request).rejects.toThrow("状态已变化");
      expect(f.tx.technicianProfile.updateMany).not.toHaveBeenCalled();
      expect(f.tx.technicianProfile.update).not.toHaveBeenCalled();
      expect(f.tx.technicianIdentityDocument.upsert).not.toHaveBeenCalled();
      expect(f.tx.technicianPhoto.create).not.toHaveBeenCalled();
    },
  );

  it("denies cross-organization document access before loading private bytes", async () => {
    const f = fixture();
    f.access.assertPermission.mockImplementation(() => {
      throw new ForbiddenException();
    });

    await expect(
      f.service.getAdminIdentityDocument(
        administrator,
        "other-org",
        "applicant",
        TechnicianIdentityDocumentKind.ID_FRONT,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.prisma.staffMembership.findFirst).not.toHaveBeenCalled();
    expect(f.tx.technicianIdentityDocument.findUnique).not.toHaveBeenCalled();
  });

  it("decrypts a scoped document only for an authorized admin and audits the view", async () => {
    const f = fixture();

    const result = await f.service.getAdminIdentityDocument(
      administrator,
      "org",
      "applicant",
      TechnicianIdentityDocumentKind.ID_FRONT,
    );

    expect(f.crypto.decryptScoped).toHaveBeenCalledWith(
      "technician-identity-document:profile:ID_FRONT",
      "encrypted-document",
    );
    expect(result).toEqual({
      content: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      mimeType: "image/jpeg",
    });
    expect(f.tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "admin",
        action: "TECHNICIAN_IDENTITY_DOCUMENT_VIEWED",
        resourceId: "document",
        metadata: { technicianId: "applicant", kind: "ID_FRONT" },
      }),
    });
  });
});
