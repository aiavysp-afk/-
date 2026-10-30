import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { AuthCryptoService } from "../auth/auth-crypto.service.js";
import { AccessControlService } from "../auth/access-control.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { TechnicianIntakeService } from "./technician-intake.service.js";

const key = "12345678-1234-4123-8123-123456789abc";
const image = Buffer.from([255, 216, 255, 217]);
const input = {
  name: "示例申请人",
  phone: "13800138000",
  certificateBase64: Buffer.from("input-fixture").toString("base64"),
  consentAccepted: true as const,
};
const actor = (): AuthPrincipal => ({
  userId: "operator",
  sessionId: "session",
  displayName: "运营",
  authChannel: "ADMIN_BROWSER",
  memberships: [{ organizationId: "org-a", role: "OPERATOR" }],
  staffVerificationMethod: "PASSWORD_SMS",
  staffVerifiedUntil: new Date(Date.now() + 60_000),
  mfaVerifiedUntil: new Date(Date.now() + 60_000),
});
function fixture() {
  const saved = new Map<string, any>();
  const crypto = new AuthCryptoService({
    get: (name: string) =>
      name === "DATA_ENCRYPTION_KEY_BASE64"
        ? Buffer.alloc(32, 7).toString("base64")
        : "synthetic-test-pepper-only-1234567890",
  } as never);
  const table = {
    findUnique: vi.fn(
      async ({ where }: any) =>
        [...saved.values()].find(
          (row) => row.submissionKeyHash === where.submissionKeyHash,
        ) ?? null,
    ),
    findFirst: vi.fn(
      async ({ where }: any) =>
        [...saved.values()].find(
          (row) =>
            row.id === where.id && row.organizationId === where.organizationId,
        ) ?? null,
    ),
    create: vi.fn(async ({ data }: any) => {
      saved.set(data.id, { version: 1, ...data });
      return saved.get(data.id);
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const row = saved.get(where.id);
      if (
        !row ||
        row.organizationId !== where.organizationId ||
        row.version !== where.version ||
        row.status !== where.status
      )
        return { count: 0 };
      saved.set(row.id, { ...row, ...data, version: row.version + 1 });
      return { count: 1 };
    }),
  };
  const prisma: any = {
    technicianIntakeApplication: table,
    organization: { findMany: vi.fn().mockResolvedValue([{ id: "org-a" }]) },
    phoneVerificationRateLimit: {
      upsert: vi.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  prisma.$transaction = vi.fn(async (operation: any) => operation(prisma));
  const photos = {
    normalize: vi.fn().mockResolvedValue({
      content: new Uint8Array(image),
      digest: "digest",
      width: 1,
      height: 1,
    }),
  };
  return {
    saved,
    table,
    prisma,
    photos,
    crypto,
    service: new TechnicianIntakeService(
      prisma,
      crypto,
      photos as never,
      new AccessControlService({ get: () => "production" } as never),
    ),
  };
}
describe("one-way anonymous technician intake", () => {
  it("writes one encrypted pending application with explicit consent, no account or staff provisioning, and no PII in acknowledgement/audit", async () => {
    const f = fixture();
    const receipt = await f.service.submit(input, key, "127.0.0.1");
    expect(receipt).toEqual({
      receiptId: expect.any(String),
      status: "PENDING_REVIEW",
    });
    const row = f.saved.get(receipt.receiptId);
    expect(row).toMatchObject({
      organizationId: "org-a",
      status: "PENDING_REVIEW",
      consentVersion: "technician-intake-2026-10-31",
      consentAcceptedAt: expect.any(Date),
    });
    expect(row.nameEncrypted).not.toContain(input.name);
    expect(row.phoneEncrypted).not.toContain(input.phone);
    expect(row.certificateEncrypted).not.toContain(image.toString("base64"));
    expect(
      f.crypto.decryptScoped(
        `technician-intake:${row.id}:name`,
        row.nameEncrypted,
      ),
    ).toBe(input.name);
    expect(
      f.crypto.decryptScoped(
        `technician-intake:${row.id}:phone`,
        row.phoneEncrypted,
      ),
    ).toBe(input.phone);
    expect(
      f.crypto.decryptScoped(
        `technician-intake:${row.id}:certificate`,
        row.certificateEncrypted,
      ),
    ).toBe(image.toString("base64"));
    expect(f.photos.normalize).toHaveBeenCalledWith(input.certificateBase64);
    expect(f.prisma.organization.findMany).toHaveBeenCalledWith({
      where: { services: { some: { published: true } } },
      select: { id: true },
      take: 2,
    });
    expect(
      JSON.stringify(receipt) +
        JSON.stringify(f.prisma.auditLog.create.mock.calls),
    ).not.toContain(input.phone);
    expect(JSON.stringify(f.prisma.auditLog.create.mock.calls)).not.toContain(
      input.name,
    );
  });
  it("reuses a successful same-key submission after timeout, but refuses changes without overwriting private data", async () => {
    const f = fixture();
    const first = await f.service.submit(input, key, "127.0.0.1");
    await expect(f.service.submit(input, key, "127.0.0.1")).resolves.toEqual(
      first,
    );
    await expect(
      f.service.submit({ ...input, name: "不同申请人" }, key, "127.0.0.1"),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.table.create).toHaveBeenCalledTimes(1);
    expect(f.photos.normalize).toHaveBeenCalledTimes(1);
    expect(f.saved.size).toBe(1);
  });
  it.each([
    { ...input, consentAccepted: false },
    { ...input, phone: "123" },
    { ...input, name: "甲" },
    { ...input, organizationId: "foreign" },
    { ...input, certificateBase64: "x".repeat(699_053) },
  ])(
    "rejects incomplete consent, invalid contact/image and client tenant injection before image or database work",
    async (value) => {
      const f = fixture();
      await expect(
        f.service.submit(value as never, key, "127.0.0.1"),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(f.table.findUnique).not.toHaveBeenCalled();
      expect(f.photos.normalize).not.toHaveBeenCalled();
    },
  );
  it("requires an unguessable well-formed submission key and a bounded proxy-derived source", async () => {
    const f = fixture();
    for (const [k, ip] of [
      [undefined, "127.0.0.1"],
      ["123", "127.0.0.1"],
      [key, "a".repeat(129)],
      [key, "\nspoof"],
    ])
      await expect(f.service.submit(input, k, ip!)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    expect(f.photos.normalize).not.toHaveBeenCalled();
  });
  it("bounds anonymous image decoding with hashed IP/global limits", async () => {
    const f = fixture();
    f.prisma.phoneVerificationRateLimit.upsert.mockResolvedValue({ count: 13 });
    const error = await f.service
      .submit(input, key, "127.0.0.1")
      .catch((error) => error);
    expect(error).toBeInstanceOf(HttpException);
    expect(error.getStatus()).toBe(429);
    expect(f.photos.normalize).not.toHaveBeenCalled();
    expect(
      JSON.stringify(f.prisma.phoneVerificationRateLimit.upsert.mock.calls),
    ).not.toContain("127.0.0.1");
  });
  it("caps per-phone submissions and global storage after image normalization but before write", async () => {
    const f = fixture();
    f.prisma.phoneVerificationRateLimit.upsert
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 4 });
    const error = await f.service
      .submit(input, key, "127.0.0.1")
      .catch((error) => error);
    expect(error.getStatus()).toBe(429);
    expect(f.table.create).not.toHaveBeenCalled();
    expect(
      JSON.stringify(f.prisma.phoneVerificationRateLimit.upsert.mock.calls),
    ).not.toContain(input.phone);
  });
  it.each([
    { organizations: [] },
    { organizations: [{ id: "org-a" }, { id: "org-b" }] },
  ])(
    "never guesses tenant ownership with zero or multiple live organizations",
    async ({ organizations }) => {
      const f = fixture();
      f.prisma.organization.findMany.mockResolvedValue(organizations);
      await expect(
        f.service.submit(input, key, "127.0.0.1"),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(f.table.create).not.toHaveBeenCalled();
    },
  );
  it("propagates image rejection without storing incomplete records", async () => {
    const f = fixture();
    f.photos.normalize.mockRejectedValue(
      new BadRequestException("invalid-image"),
    );
    await expect(
      f.service.submit(input, key, "127.0.0.1"),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(f.table.create).not.toHaveBeenCalled();
  });
  it("reads certificate bytes only after scoped authorization and records a private-read audit", async () => {
    const f = fixture();
    const receipt = await f.service.submit(input, key, "127.0.0.1");
    for (const principal of [
      {
        ...actor(),
        memberships: [{ organizationId: "org-b", role: "OPERATOR" }],
      },
      { ...actor(), authChannel: "CUSTOMER_SMS" },
      {
        ...actor(),
        memberships: [{ organizationId: "org-a", role: "THERAPIST" }],
      },
    ])
      await expect(
        f.service.certificate(
          principal as AuthPrincipal,
          "org-a",
          receipt.receiptId,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.table.findFirst).not.toHaveBeenCalled();
    await expect(
      f.service.certificate(actor(), "org-a", receipt.receiptId),
    ).resolves.toEqual(image);
    expect(f.prisma.auditLog.create.mock.calls.at(-1)[0].data).toMatchObject({
      action: "TECHNICIAN_INTAKE_CERTIFICATE_VIEWED",
      resourceId: receipt.receiptId,
    });
    await expect(
      f.service.certificate(actor(), "org-a", "foreign"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
  it("never returns corrupted or row-swapped certificate ciphertext", async () => {
    const f = fixture();
    const receipt = await f.service.submit(input, key, "127.0.0.1");
    f.saved.get(receipt.receiptId).certificateEncrypted =
      f.crypto.encryptScoped("other-row", image.toString("base64"));
    await expect(
      f.service.certificate(actor(), "org-a", receipt.receiptId),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
  it("requires fresh MFA and current pending version, then audits one state update without creating staff access", async () => {
    const f = fixture();
    const receipt = await f.service.submit(input, key, "127.0.0.1");
    await expect(
      f.service.review(
        { ...actor(), mfaVerifiedUntil: null },
        "org-a",
        receipt.receiptId,
        "approve",
        1,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.table.updateMany).not.toHaveBeenCalled();
    await expect(
      f.service.review(actor(), "org-a", receipt.receiptId, "approve", 2),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      f.service.review(actor(), "org-a", receipt.receiptId, "approve", 1),
    ).resolves.toEqual({
      technicianId: receipt.receiptId,
      status: "APPROVED",
      version: 2,
    });
    await expect(
      f.service.review(
        actor(),
        "org-a",
        receipt.receiptId,
        "reject",
        1,
        "资料不符合",
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.saved.get(receipt.receiptId).status).toBe("APPROVED");
    expect(
      f.prisma.auditLog.create.mock.calls.filter(
        (call: any) => call[0].data.action === "TECHNICIAN_INTAKE_APPROVED",
      ),
    ).toHaveLength(1);
  });
  it("requires a reason for rejection and stores it without putting its text in audit metadata", async () => {
    const f = fixture();
    const receipt = await f.service.submit(input, key, "127.0.0.1");
    await expect(
      f.service.review(actor(), "org-a", receipt.receiptId, "reject", 1, ""),
    ).rejects.toBeInstanceOf(BadRequestException);
    await f.service.review(
      actor(),
      "org-a",
      receipt.receiptId,
      "reject",
      1,
      " 请补充清晰证书 ",
    );
    expect(f.saved.get(receipt.receiptId)).toMatchObject({
      status: "REJECTED",
      version: 2,
      rejectionReason: "请补充清晰证书",
      reviewedById: "operator",
    });
    expect(JSON.stringify(f.prisma.auditLog.create.mock.calls)).not.toContain(
      "请补充清晰证书",
    );
  });
});
