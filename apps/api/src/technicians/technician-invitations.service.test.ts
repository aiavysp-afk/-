import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import {
  MembershipStatus,
  TechnicianInvitationStatus,
  TechnicianProfileStatus,
  UserRole,
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { TechnicianInvitationsService } from "./technician-invitations.service.js";

const now = new Date("2026-10-10T00:30:00.000Z");
const admin: AuthPrincipal = {
  sessionId: "session-admin",
  userId: "admin-1",
  displayName: "管理员",
  memberships: [{ organizationId: "org-1", role: UserRole.OPERATOR }],
  mfaVerifiedUntil: new Date("2026-10-10T01:00:00.000Z"),
};
const customer: AuthPrincipal = {
  sessionId: "session-customer",
  userId: "customer-1",
  displayName: "微信用户",
  memberships: [],
};

function invitation(overrides: Record<string, unknown> = {}) {
  return {
    id: "invite-1",
    organizationId: "org-1",
    publicName: "王晓布",
    tokenHash: "hash-code",
    status: TechnicianInvitationStatus.PENDING,
    expiresAt: new Date("2026-10-13T00:30:00.000Z"),
    createdById: admin.userId,
    claimedById: null,
    claimedAt: null,
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
    organization: { name: "中原到家" },
    claimedBy: null,
    ...overrides,
  };
}

function setup() {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    user: {
      findUnique: vi.fn().mockResolvedValue({
        id: customer.userId,
        status: "ACTIVE",
        phoneVerifiedAt: now,
        displayName: customer.displayName,
      }),
    },
    technicianInvitation: {
      create: vi.fn().mockResolvedValue(invitation()),
      findFirst: vi.fn().mockResolvedValue(invitation()),
      findUnique: vi.fn().mockResolvedValue(invitation()),
      findUniqueOrThrow: vi.fn().mockResolvedValue(invitation()),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    technicianProfile: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({ id: "profile-1" }),
    },
    staffMembership: {
      upsert: vi.fn().mockResolvedValue({ id: "membership-1" }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
    outboxEvent: { create: vi.fn().mockResolvedValue({ id: "event-1" }) },
  };
  const prisma = {
    technicianInvitation: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    browserLoginRateLimit: {
      upsert: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  const access = { assertPermission: vi.fn() };
  const crypto = {
    hashBrowserLogin: vi.fn(
      (purpose: string, value: string) => `hash:${purpose}:${value}`,
    ),
  };
  return {
    tx,
    prisma,
    access,
    crypto,
    service: new TechnicianInvitationsService(
      prisma as never,
      access as never,
      crypto as never,
    ),
  };
}

describe("TechnicianInvitationsService", () => {
  it("creates a one-time code, stores only its hash, and writes an audit record", async () => {
    const fixture = setup();

    const result = await fixture.service.create(
      admin,
      "org-1",
      { publicName: "王晓布", expiresInHours: 72 },
      now,
    );

    expect(fixture.access.assertPermission).toHaveBeenCalledWith(
      admin,
      "technicians.manage",
      "org-1",
    );
    expect(result.code).toMatch(/^[A-Z0-9_-]{12}$/);
    expect(result.miniappPath).toContain(encodeURIComponent(result.code));
    expect(fixture.tx.technicianInvitation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          publicName: "王晓布",
          tokenHash: `hash:technician-invitation:${result.code}`,
        }),
      }),
    );
    expect(
      JSON.stringify(fixture.tx.technicianInvitation.create.mock.calls),
    ).not.toContain(`"code":"${result.code}"`);
    expect(fixture.tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "TECHNICIAN_INVITATION_CREATED",
        }),
      }),
    );
  });

  it("claims an invitation into an active therapist membership and draft profile", async () => {
    const fixture = setup();
    const result = await fixture.service.claim(customer, "ABCDEFGHIJKL", now);

    expect(fixture.tx.staffMembership.upsert).toHaveBeenCalledWith({
      where: {
        userId_organizationId_role: {
          userId: customer.userId,
          organizationId: "org-1",
          role: UserRole.THERAPIST,
        },
      },
      create: {
        userId: customer.userId,
        organizationId: "org-1",
        role: UserRole.THERAPIST,
        status: MembershipStatus.ACTIVE,
      },
      update: { status: MembershipStatus.ACTIVE },
    });
    expect(fixture.tx.technicianProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          technicianId: customer.userId,
          publicName: "王晓布",
          status: TechnicianProfileStatus.DRAFT,
        }),
      }),
    );
    expect(fixture.tx.technicianInvitation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          status: TechnicianInvitationStatus.CLAIMED,
          claimedById: customer.userId,
          claimedAt: now,
        },
      }),
    );
    expect(result).toEqual({
      invitationId: "invite-1",
      organizationId: "org-1",
      organizationName: "中原到家",
      publicName: "王晓布",
      profileStatus: "DRAFT",
      claimedAt: now.toISOString(),
    });
  });

  it("requires verified phone ownership before any membership write", async () => {
    const fixture = setup();
    fixture.tx.user.findUnique.mockResolvedValue({
      id: customer.userId,
      status: "ACTIVE",
      phoneVerifiedAt: null,
      displayName: customer.displayName,
    });

    await expect(
      fixture.service.claim(customer, "ABCDEFGHIJKL", now),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(fixture.tx.staffMembership.upsert).not.toHaveBeenCalled();
    expect(fixture.tx.technicianProfile.upsert).not.toHaveBeenCalled();
  });

  it("does not consume another invitation for an existing technician profile", async () => {
    const fixture = setup();
    fixture.tx.technicianProfile.findUnique.mockResolvedValue({
      organizationId: "org-1",
    });

    await expect(
      fixture.service.claim(customer, "ABCDEFGHIJKL", now),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(fixture.tx.technicianInvitation.updateMany).not.toHaveBeenCalled();
  });

  it("uses one generic error for unknown, revoked, used, or expired codes", async () => {
    const fixture = setup();
    fixture.tx.technicianInvitation.findUnique.mockResolvedValue(null);

    await expect(
      fixture.service.claim(customer, "ABCDEFGHIJKL", now),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(fixture.tx.staffMembership.upsert).not.toHaveBeenCalled();
  });
});
