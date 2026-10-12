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
  const documentFindMany = vi.fn().mockResolvedValue([
    { kind: TechnicianIdentityDocumentKind.ID_FRONT },
  ]);
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
  it("allows an existing self-registered miniapp profile to resume through H5", async () => {
    const f = fixture();
    f.prisma.technicianProfile.findFirst.mockResolvedValue(
      profile({
        registrationChannel: "WECHAT_MINIAPP",
        status: "PENDING_REVIEW",
      }),
    );

    await expect(f.service.h5OnboardingStatus(h5Applicant)).resolves.toMatchObject({
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
        where: expect.not.objectContaining({ registrationChannel: "WECHAT_H5" }),
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
