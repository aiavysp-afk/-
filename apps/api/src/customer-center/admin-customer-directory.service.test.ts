import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import type { UserRole } from "@prisma/client";
import {
  AdminCustomerDirectorySchema,
  AdminCustomerPhoneRevealSchema,
} from "@zydj/contracts";
import { describe, expect, it, vi } from "vitest";
import { AccessControlService } from "../auth/access-control.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { AdminCustomerDirectoryService } from "./admin-customer-directory.service.js";

const phone = "13800138000";
const encrypted = "encrypted-fixture-phone";
const createdAt = new Date("2026-10-15T10:00:00.000Z");
const row = {
  id: "customer-1",
  displayName: "客户",
  phoneEncrypted: encrypted,
  phoneVerifiedAt: createdAt,
  createdAt,
};

function principal(
  role: UserRole = "OPERATOR",
  organizationId = "org-1",
): AuthPrincipal {
  return {
    userId: "operator-1",
    sessionId: "session",
    displayName: "运营",
    memberships: [{ organizationId, role }],
    authChannel: "ADMIN_BROWSER",
    mfaVerifiedUntil: new Date(Date.now() + 5 * 60_000),
  };
}
function setup() {
  const tx = {
    user: { findFirst: vi.fn().mockResolvedValue(row) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit" }) },
  };
  const prisma = {
    user: { findMany: vi.fn().mockResolvedValue([row]) },
    $transaction: vi.fn(async (run: (client: typeof tx) => unknown) => run(tx)),
  };
  const crypto = {
    decrypt: vi.fn().mockReturnValue(phone),
    hashPhoneVerification: vi.fn().mockReturnValue("keyed-reason-digest"),
  };
  const access = new AccessControlService({ get: () => "production" } as never);
  return {
    tx,
    prisma,
    crypto,
    service: new AdminCustomerDirectoryService(
      prisma as never,
      access,
      crypto as never,
    ),
  };
}

function expectedScope() {
  return {
    status: "ACTIVE",
    OR: [
      { customerOrders: { some: { organizationId: "org-1" } } },
      { customerReservations: { some: { organizationId: "org-1" } } },
      { storedValueAccounts: { some: { organizationId: "org-1" } } },
      { customerCoupons: { some: { organizationId: "org-1" } } },
      { customerAddresses: { some: { organizationId: "org-1" } } },
      { customerFeedbacks: { some: { organizationId: "org-1" } } },
      { accountDeletionRequests: { some: { organizationId: "org-1" } } },
    ],
  };
}

describe("organization customer phone directory", () => {
  it("lists only scoped business customers with a bounded stable cursor and masked phones", async () => {
    const f = setup();
    f.prisma.user.findMany.mockResolvedValue([
      row,
      { ...row, id: "customer-2" },
    ]);
    const result = AdminCustomerDirectorySchema.parse(
      await f.service.list(principal(), "org-1", {
        limit: 1,
        cursor: "customer-0",
      }),
    );
    expect(result).toEqual({
      items: [
        {
          userId: row.id,
          displayName: row.displayName,
          maskedPhone: "138****8000",
          phoneVerified: true,
          createdAt: createdAt.toISOString(),
        },
      ],
      nextCursor: row.id,
    });
    expect(f.prisma.user.findMany).toHaveBeenCalledWith({
      where: { AND: [expectedScope(), { id: { gt: "customer-0" } }] },
      select: {
        id: true,
        displayName: true,
        phoneEncrypted: true,
        phoneVerifiedAt: true,
        createdAt: true,
      },
      orderBy: { id: "asc" },
      take: 2,
    });
    expect(JSON.stringify(result)).not.toContain(phone);
    expect(JSON.stringify(result)).not.toContain(encrypted);
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("requires neither new registration ownership nor a global User role fallback", async () => {
    const f = setup();
    f.prisma.user.findMany.mockResolvedValue([]);
    await expect(
      f.service.list(principal(), "org-1", { limit: 20 }),
    ).resolves.toEqual({ items: [], nextCursor: null });
    expect(f.prisma.user.findMany.mock.calls[0]![0].where).toEqual({
      AND: [expectedScope()],
    });
  });

  it("shows no phone for unverified or unreadable historical fields", async () => {
    const f = setup();
    f.prisma.user.findMany.mockResolvedValue([
      { ...row, phoneVerifiedAt: null } as never,
    ]);
    expect(
      (await f.service.list(principal(), "org-1", { limit: 20 })).items[0],
    ).toMatchObject({ phoneVerified: false, maskedPhone: null });
    expect(f.crypto.decrypt).not.toHaveBeenCalled();
    f.prisma.user.findMany.mockResolvedValue([row]);
    f.crypto.decrypt.mockImplementation(() => {
      throw new Error(`private ${encrypted}`);
    });
    expect(
      (await f.service.list(principal(), "org-1", { limit: 20 })).items[0],
    ).toMatchObject({ phoneVerified: false, maskedPhone: null });
  });

  it.each([
    "CUSTOMER",
    "THERAPIST",
    "DISPATCHER",
    "FINANCE_REQUESTER",
    "FINANCE_APPROVER",
    "SAFETY_DUTY",
  ] as UserRole[])(
    "denies %s without changing any role grants",
    async (role) => {
      const f = setup();
      await expect(
        f.service.list(principal(role), "org-1", { limit: 20 }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        f.service.revealPhone(principal(role), "org-1", row.id, {
          reason: "核对预约联系",
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(f.prisma.user.findMany).not.toHaveBeenCalled();
      expect(f.prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it("denies guests, cross-organization staff and customer SMS even with forged staff claims", async () => {
    const f = setup();
    for (const actor of [
      { ...principal(), memberships: [] },
      principal("OPERATOR", "other-org"),
      { ...principal(), authChannel: "CUSTOMER_SMS" },
      { ...principal(), authProvider: "customer-sms" },
    ]) {
      await expect(
        f.service.list(actor, "org-1", { limit: 20 }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        f.service.revealPhone(actor, "org-1", row.id, {
          reason: "核对预约联系",
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(f.prisma.user.findMany).not.toHaveBeenCalled();
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("allows trusted-device list reads but never substitutes remembered login for fresh MFA reveal", async () => {
    const f = setup();
    const trusted = {
      ...principal(),
      mfaVerifiedUntil: null,
      staffVerificationMethod: "TRUSTED_DEVICE",
      staffVerifiedUntil: new Date(Date.now() + 60_000),
    };
    await expect(
      f.service.list(trusted, "org-1", { limit: 20 }),
    ).resolves.toHaveProperty("items");
    await expect(
      f.service.revealPhone(trusted, "org-1", row.id, {
        reason: "核对预约联系",
      }),
    ).rejects.toThrow("动态码");
    expect(f.tx.user.findFirst).not.toHaveBeenCalled();
    expect(f.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("audits a scoped reveal before returning a short-lived phone, without any plaintext reason or phone in audit", async () => {
    const f = setup();
    const before = Date.now();
    const reason = `核对预约联系 ${phone}`;
    const result = AdminCustomerPhoneRevealSchema.parse(
      await f.service.revealPhone(principal(), "org-1", row.id, { reason }),
    );
    expect(result).toMatchObject({ userId: row.id, phone });
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThanOrEqual(
      before + 59_000,
    );
    expect(new Date(result.expiresAt).getTime()).toBeLessThanOrEqual(
      Date.now() + 60_000,
    );
    expect(f.tx.user.findFirst.mock.calls[0]![0].where).toEqual({
      AND: [expectedScope(), { id: row.id }],
    });
    expect(f.crypto.hashPhoneVerification).toHaveBeenCalledWith(
      "admin-customer-phone-reveal-reason",
      reason,
    );
    expect(f.tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        actorId: "operator-1",
        organizationId: "org-1",
        action: "CUSTOMER_VERIFIED_PHONE_REVEALED",
        resourceType: "User",
        resourceId: row.id,
        metadata: {
          purpose: "CUSTOMER_SERVICE_CONTACT",
          reasonProvided: true,
          reasonHash: "keyed-reason-digest",
        },
      },
    });
    expect(JSON.stringify(f.tx.auditLog.create.mock.calls)).not.toMatch(
      new RegExp(`${phone}|${encrypted}|核对预约联系`),
    );
  });

  it("caps display validity at the fresh-MFA deadline", async () => {
    const f = setup();
    const actor = principal();
    actor.mfaVerifiedUntil = new Date(Date.now() + 15_000);
    const result = await f.service.revealPhone(actor, "org-1", row.id, {
      reason: "核对预约联系",
    });
    expect(result.expiresAt).toBe(actor.mfaVerifiedUntil.toISOString());
  });

  it("does not disclose if audit persistence fails", async () => {
    const f = setup();
    f.tx.auditLog.create.mockRejectedValue(new Error("audit unavailable"));
    await expect(
      f.service.revealPhone(principal(), "org-1", row.id, {
        reason: "核对预约联系",
      }),
    ).rejects.toThrow("audit unavailable");
  });

  it("rechecks MFA after database work and fails closed if it expires", async () => {
    const f = setup();
    const actor = principal();
    f.tx.auditLog.create.mockImplementation(async () => {
      actor.mfaVerifiedUntil = new Date(0);
      return { id: "audit" };
    });
    await expect(
      f.service.revealPhone(actor, "org-1", row.id, { reason: "核对预约联系" }),
    ).rejects.toThrow("动态码");
  });

  it("reapplies organization membership instead of trusting a customer ID from the list", async () => {
    const f = setup();
    f.tx.user.findFirst.mockResolvedValue(null);
    await expect(
      f.service.revealPhone(principal(), "org-1", "other-org-customer", {
        reason: "核对预约联系",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(f.tx.user.findFirst.mock.calls[0]![0].where).toEqual({
      AND: [expectedScope(), { id: "other-org-customer" }],
    });
    expect(f.crypto.decrypt).not.toHaveBeenCalled();
    expect(f.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("does not reveal an unverified, malformed or undecryptable number", async () => {
    const f = setup();
    f.tx.user.findFirst.mockResolvedValue({
      ...row,
      phoneVerifiedAt: null,
    } as never);
    await expect(
      f.service.revealPhone(principal(), "org-1", row.id, {
        reason: "核对预约联系",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    f.tx.user.findFirst.mockResolvedValue(row);
    f.crypto.decrypt.mockReturnValue("private malformed phone");
    await expect(
      f.service.revealPhone(principal(), "org-1", row.id, {
        reason: "核对预约联系",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    f.crypto.decrypt.mockImplementation(() => {
      throw new Error(`private ${encrypted}`);
    });
    await expect(
      f.service.revealPhone(principal(), "org-1", row.id, {
        reason: "核对预约联系",
      }),
    ).rejects.toThrow("暂无可查看");
    expect(f.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("validates direct service callers before accessing customer data", async () => {
    const f = setup();
    for (const limit of [0, 101, 1.2])
      await expect(
        f.service.list(principal(), "org-1", { limit }),
      ).rejects.toBeInstanceOf(BadRequestException);
    for (const reason of ["", "查看", "x".repeat(201)])
      await expect(
        f.service.revealPhone(principal(), "org-1", row.id, { reason }),
      ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      f.service.revealPhone(principal(), "org-1", "../other", {
        reason: "核对预约联系",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(f.prisma.user.findMany).not.toHaveBeenCalled();
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
});
