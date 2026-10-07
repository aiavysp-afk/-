import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../database/prisma.service.js";
import type { AliyunSmsClient } from "../integrations/aliyun-sms.client.js";
import type { AuthCryptoService } from "./auth-crypto.service.js";
import type { AuthPrincipal } from "./auth.types.js";
import { PhoneVerificationSmsService } from "./phone-verification-sms.service.js";

const principal: AuthPrincipal = {
  sessionId: "session-1",
  userId: "user-1",
  displayName: "微信用户",
  memberships: [],
};
const digest = (purpose: string, value: string) =>
  createHash("sha256").update(`${purpose}:${value}`).digest("hex");
const crypto = {
  hashPhoneVerification: vi.fn(digest),
  encrypt: vi.fn((value: string) => `encrypted:${value.length}`),
  decrypt: vi.fn(() => "13800138000"),
} as unknown as AuthCryptoService;

describe("PhoneVerificationSmsService", () => {
  it("persists a bounded challenge before submitting the dedicated OTP", async () => {
    const challengeCreate = vi.fn();
    const auditCreate = vi.fn();
    const update = vi.fn();
    const tx = {
      user: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({ phoneVerifiedAt: null }),
      },
      phoneVerificationChallenge: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: challengeCreate,
      },
      phoneVerificationRateLimit: {
        upsert: vi.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: { create: auditCreate },
    };
    const prisma = {
      $transaction: vi.fn(async (callback) => callback(tx)),
      phoneVerificationChallenge: { update, updateMany: vi.fn() },
    } as unknown as PrismaService;
    const sms = {
      submitPhoneVerification: vi.fn().mockResolvedValue({
        status: "ACCEPTED",
        requestId: "request-1",
        bizId: "biz-1",
      }),
    } as unknown as AliyunSmsClient;
    const service = new PhoneVerificationSmsService(prisma, crypto, sms);

    await expect(
      service.request(principal, { phone: "13800138000" }),
    ).resolves.toMatchObject({ status: "ACCEPTED", retryAfterSeconds: 60 });
    expect(sms.submitPhoneVerification).toHaveBeenCalledWith({
      phone: "13800138000",
      code: expect.stringMatching(/^\d{6}$/),
      trackingId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    const saved = challengeCreate.mock.calls[0]![0].data;
    expect(saved.phoneEncrypted).toBe("encrypted:11");
    expect(saved.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(auditCreate.mock.calls)).not.toContain("13800138000");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "ACCEPTED" }) }),
    );
  });

  it("atomically consumes a valid code and refuses to overwrite a verified phone", async () => {
    const challengeId = "challenge-1";
    const code = "123456";
    const challenge = {
      id: challengeId,
      codeHash: digest("code", `${challengeId}:${code}`),
      expiresAt: new Date(Date.now() + 60_000),
      attempts: 0,
    };
    const tx = {
      user: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      phoneVerificationChallenge: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: { create: vi.fn() },
    };
    const prisma = {
      user: {
        findUniqueOrThrow: vi
          .fn()
          .mockResolvedValue({ phoneEncrypted: null, phoneVerifiedAt: null }),
      },
      phoneVerificationChallenge: {
        findFirst: vi.fn().mockResolvedValue(challenge),
        updateMany: vi.fn(),
      },
      $transaction: vi.fn(async (callback) => callback(tx)),
    } as unknown as PrismaService;
    const service = new PhoneVerificationSmsService(
      prisma,
      crypto,
      {} as AliyunSmsClient,
    );

    await expect(
      service.confirm(principal, { phone: "13800138000", code }),
    ).resolves.toEqual({
      phoneVerified: true,
      maskedPhone: "138****8000",
    });
    expect(tx.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "user-1", phoneVerifiedAt: null },
      }),
    );

    prisma.user.findUniqueOrThrow = vi.fn().mockResolvedValue({
      phoneEncrypted: "existing",
      phoneVerifiedAt: new Date(),
    });
    (crypto.decrypt as ReturnType<typeof vi.fn>).mockReturnValue("13900139000");
    await expect(
      service.confirm(principal, { phone: "13800138000", code }),
    ).rejects.toThrow("已经完成验证");
  });

  it("increments attempts without exposing the expected code", async () => {
    const attemptUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      user: {
        findUniqueOrThrow: vi
          .fn()
          .mockResolvedValue({ phoneEncrypted: null, phoneVerifiedAt: null }),
      },
      phoneVerificationChallenge: {
        findFirst: vi.fn().mockResolvedValue({
          id: "challenge-2",
          codeHash: digest("code", "challenge-2:654321"),
          expiresAt: new Date(Date.now() + 60_000),
          attempts: 0,
        }),
        updateMany: attemptUpdate,
      },
    } as unknown as PrismaService;
    const service = new PhoneVerificationSmsService(
      prisma,
      crypto,
      {} as AliyunSmsClient,
    );

    await expect(
      service.confirm(principal, {
        phone: "13800138000",
        code: "123456",
      }),
    ).rejects.toThrow("验证码不正确");
    expect(attemptUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { attempts: { increment: 1 } } }),
    );
  });
});
