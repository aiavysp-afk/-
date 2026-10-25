import { describe, it, expect, vi } from "vitest";
import { AccessControlService } from "../auth/access-control.service.js";
import { TechnicianShowcaseService } from "./technician-showcase.service.js";
import { TechnicianShowcaseSaveSchema } from "@zydj/contracts";
const operator = {
  userId: "ops",
  sessionId: "s",
  displayName: "ops",
  memberships: [{ organizationId: "org", role: "OPERATOR" as const }],
};
function fixture() {
  const profile = {
    id: "profile",
    version: 3,
    status: "DRAFT",
    showcasePhotoId: null,
    avatarUrl: "https://api.mtsc.top/v1/technicians/owner/photos/photo-1",
    photos: [{ id: "photo-1" }],
    photoDraftBinding: null,
  };
  const db = {
    service: {
      findFirst: vi.fn().mockResolvedValue({ organizationId: "org" }),
    },
    technicianProfile: {
      findFirst: vi.fn().mockResolvedValue(profile),
      findMany: vi
        .fn()
        .mockResolvedValue([{ ...profile, showcasePhotoId: "photo-1" }]),
      update: vi.fn().mockResolvedValue({ version: 4 }),
    },
    technicianPhoto: {
      findFirst: vi.fn().mockResolvedValue({ content: new Uint8Array([1]) }),
    },
    auditLog: { create: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((fn) => fn(db));
  return {
    db,
    profile,
    service: new TechnicianShowcaseService(
      db as never,
      new AccessControlService(),
    ),
  };
}
describe("explicit portrait publication", () => {
  it("returns only selected image IDs and paths from the customer service organization", async () => {
    const { db, service } = fixture();
    expect(await service.list()).toEqual([
      { id: "photo-1", imagePath: "/technician-showcase/photos/photo-1" },
    ]);
    expect(db.technicianProfile.findMany.mock.calls[0]![0].where).toMatchObject(
      {
        organizationId: "org",
        registrationChannel: "ADMIN_PHOTO_DRAFT",
        status: "DRAFT",
        photoDraftBinding: null,
      },
    );
    db.technicianProfile.findMany.mockResolvedValue([
      { showcasePhotoId: "someone-else", photos: [{ id: "photo-1" }] },
    ]);
    expect(await service.list()).toEqual([]);
  });
  it("rejects missing, unpublished, cross-owner and withdrawn photos", async () => {
    const { db, service } = fixture();
    db.technicianPhoto.findFirst.mockResolvedValue(null as never);
    await expect(service.image("unknown")).rejects.toThrow();
    expect(
      db.technicianPhoto.findFirst.mock.calls[0]![0].where.profile,
    ).toMatchObject({
      showcasePhotoId: "unknown",
      organizationId: "org",
      photoDraftBinding: null,
    });
    db.service.findFirst.mockResolvedValue(null as never);
    expect(await service.list()).toEqual([]);
  });
  it("requires organization permission and current version before publication", async () => {
    const { db, service } = fixture();
    await expect(
      service.save({ ...operator, memberships: [] }, "org", "owner", {
        enabled: true,
        expectedVersion: 3,
      }),
    ).rejects.toThrow();
    await expect(
      service.save(operator, "other", "owner", {
        enabled: true,
        expectedVersion: 3,
      }),
    ).rejects.toThrow();
    expect(db.$transaction).not.toHaveBeenCalled();
    await expect(
      service.save(operator, "org", "owner", {
        enabled: true,
        expectedVersion: 2,
      }),
    ).rejects.toThrow(/刷新/);
    expect(db.technicianProfile.update).not.toHaveBeenCalled();
  });
  it("publishes only an owned avatar and never changes review, identity or booking fields", async () => {
    const { db, profile, service } = fixture();
    await service.save(operator, "org", "owner", {
      enabled: true,
      expectedVersion: 3,
    });
    expect(db.technicianProfile.update.mock.calls[0]![0].data).toEqual({
      showcasePhotoId: "photo-1",
      version: { increment: 1 },
    });
    profile.photoDraftBinding = {} as never;
    await expect(
      service.save(operator, "org", "owner", {
        enabled: true,
        expectedVersion: 3,
      }),
    ).rejects.toThrow(/本人申请/);
    profile.photoDraftBinding = null;
    profile.avatarUrl =
      "https://api.mtsc.top/v1/technicians/another/photos/photo-1";
    await expect(
      service.save(operator, "org", "owner", {
        enabled: true,
        expectedVersion: 3,
      }),
    ).rejects.toThrow(/头像/);
    await service.save(operator, "org", "owner", {
      enabled: false,
      expectedVersion: 3,
    });
  });
  it("accepts only a boolean flag and a version", () => {
    expect(
      TechnicianShowcaseSaveSchema.safeParse({
        enabled: true,
        expectedVersion: 0,
        approved: true,
      }).success,
    ).toBe(false);
  });
});
