import { ConfigService } from "@nestjs/config";
import { UserRole } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../config/env.js";
import type { PrismaService } from "../database/prisma.service.js";
import type { AuthCryptoService } from "./auth-crypto.service.js";
import { AuthService } from "./auth.service.js";
import type { WechatMiniappClient } from "./wechat-miniapp.client.js";

describe("AuthService", () => {
  it("refuses H5 identity binding without a UnionID", async () => {
    const auth = new AuthService(
      {} as never,
      {} as never,
      {} as never,
      new ConfigService({ TECHNICIAN_H5_APP_ID: "wx-h5" }) as ConfigService<
        AppEnv,
        true
      >,
    );
    await expect(
      auth.identifyWechatH5({ openId: "openid-without-unionid" }),
    ).rejects.toThrow("未获取到UnionID");
  });

  it("reuses the unique UnionID owner across miniapp and H5 without creating another user", async () => {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      externalIdentity: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "h5-identity" }),
      },
      wechatUnionIdentity: {
        findUnique: vi.fn().mockResolvedValue({
          unionIdHash: "union-hash",
          userId: "existing-user",
        }),
        create: vi.fn(),
      },
      user: { create: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
    } as unknown as PrismaService;
    const crypto = {
      hashIdentity: vi.fn((scope: string) =>
        scope === "unionid" ? "union-hash" : "subject-hash",
      ),
      encrypt: vi.fn((value: string) => `encrypted:${value}`),
    } as unknown as AuthCryptoService;
    const auth = new AuthService(
      prisma,
      crypto,
      {} as never,
      new ConfigService({ TECHNICIAN_H5_APP_ID: "wx-h5" }) as ConfigService<
        AppEnv,
        true
      >,
    );

    await expect(
      auth.identifyWechatH5({
        openId: "h5-openid",
        unionId: "shared-unionid",
      }),
    ).resolves.toBe("existing-user");
    expect(tx.user.create).not.toHaveBeenCalled();
    expect(tx.wechatUnionIdentity.create).not.toHaveBeenCalled();
    expect(tx.externalIdentity.create).toHaveBeenCalledWith({
      data: {
        provider: "WECHAT_H5",
        subjectHash: "subject-hash",
        subjectEncrypted: "encrypted:h5-openid",
        unionIdHash: "union-hash",
        unionIdEncrypted: "encrypted:shared-unionid",
        userId: "existing-user",
      },
    });
  });

  it("fails closed when an H5 openid and UnionID point at different users", async () => {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      externalIdentity: {
        findUnique: vi.fn().mockResolvedValue({
          id: "external",
          userId: "user-a",
          unionIdHash: "union-hash",
        }),
      },
      wechatUnionIdentity: {
        findUnique: vi.fn().mockResolvedValue({
          unionIdHash: "union-hash",
          userId: "user-b",
        }),
      },
    };
    const auth = new AuthService(
      {
        $transaction: vi.fn(
          async (callback: (client: typeof tx) => unknown) => callback(tx),
        ),
      } as never,
      {
        hashIdentity: vi.fn((scope: string) =>
          scope === "unionid" ? "union-hash" : "subject-hash",
        ),
        encrypt: vi.fn((value: string) => `encrypted:${value}`),
      } as never,
      {} as never,
      new ConfigService({ TECHNICIAN_H5_APP_ID: "wx-h5" }) as ConfigService<
        AppEnv,
        true
      >,
    );

    await expect(
      auth.identifyWechatH5({
        openId: "h5-openid",
        unionId: "shared-unionid",
      }),
    ).rejects.toThrow("UnionID已绑定其他账号");
  });

  it("takes native authentication provenance and phone verification only from the stored session/user", async () => {
    const session = { id: "session", authChannel: "WECHAT_MINIAPP", authProvider: "wechat", expiresAt: new Date(Date.now() + 60_000), revokedAt: null, mfaVerifiedUntil: null, user: { id: "user", status: "ACTIVE", displayName: "微信用户", phoneEncrypted: "encrypted-fixture", phoneVerifiedAt: new Date(), memberships: [{ organizationId: "org", role: UserRole.THERAPIST }] } };
    const prisma = { session: { findUnique: vi.fn().mockResolvedValue(session), update: vi.fn() } };
    const service = new AuthService(prisma as never, { hashSessionToken: () => "hash" } as never, {} as never, {} as never);
    await expect(service.authenticate("x".repeat(40))).resolves.toMatchObject({ authChannel: "WECHAT_MINIAPP", authProvider: "wechat", phoneVerified: true });
    session.authChannel = "BROWSER"; session.user.phoneVerifiedAt = null as never;
    await expect(service.authenticate("x".repeat(40))).resolves.toMatchObject({ authChannel: "BROWSER", phoneVerified: false });
    expect(prisma.session.findUnique).toHaveBeenCalledWith(expect.objectContaining({ include: { user: { include: { memberships: { where: { status: "ACTIVE" } } } } } }));
  });
  it("creates every new miniapp identity as a customer and returns only an opaque session token", async () => {
    const tx = {
      externalIdentity: {
        upsert: vi.fn().mockResolvedValue({
          user: {
            id: "user-1",
            status: "ACTIVE",
            displayName: "微信用户",
            phoneEncrypted: null,
            phoneVerifiedAt: null,
            memberships: [],
          },
        }),
      },
      session: { create: vi.fn().mockResolvedValue({ id: "session-1" }) },
      auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
    } as unknown as PrismaService;
    const crypto = {
      hashIdentity: vi.fn().mockReturnValue("identity-hash"),
      createSessionToken: vi
        .fn()
        .mockReturnValue("opaque-session-token-with-sufficient-length-1234"),
      hashSessionToken: vi.fn().mockReturnValue("session-token-hash"),
      encrypt: vi.fn().mockReturnValue("encrypted-identity"),
    } as unknown as AuthCryptoService;
    const wechat = {
      exchangeCode: vi.fn().mockResolvedValue({ openId: "openid-from-wechat" }),
    } as unknown as WechatMiniappClient;
    const config = new ConfigService({
      WECHAT_MINIAPP_APP_ID: "wx-test-app",
      AUTH_SESSION_TTL_SECONDS: 600,
    }) as ConfigService<AppEnv, true>;
    const auth = new AuthService(prisma, crypto, wechat, config);

    const result = await auth.loginWithWechat("one-time-code");

    expect(tx.externalIdentity.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          user: {
            create: expect.objectContaining({ role: UserRole.CUSTOMER }),
          },
        }),
      }),
    );
    expect(result.accessToken).toBe(
      "opaque-session-token-with-sufficient-length-1234",
    );
    expect(JSON.stringify(result)).not.toContain("openid-from-wechat");
    expect(JSON.stringify(result)).not.toContain("identity-hash");
    expect(result.user.phoneVerified).toBe(false);
  });

  it("stores an encrypted WeChat phone number without writing the plaintext to audit metadata", async () => {
    const auditCreate = vi.fn().mockResolvedValue({ id: "audit-1" });
    const prisma = {
      user: { update: vi.fn().mockResolvedValue({ id: "user-1" }) },
      auditLog: { create: auditCreate },
      $transaction: vi.fn().mockResolvedValue([]),
    } as unknown as PrismaService;
    const crypto = {
      encrypt: vi.fn().mockReturnValue("encrypted-phone"),
    } as unknown as AuthCryptoService;
    const wechat = {
      exchangePhoneCode: vi
        .fn()
        .mockResolvedValue({ phoneNumber: "13800138000" }),
    } as unknown as WechatMiniappClient;
    const auth = new AuthService(
      prisma,
      crypto,
      wechat,
      new ConfigService({}) as ConfigService<AppEnv, true>,
    );
    const result = await auth.verifyWechatPhone(
      {
        sessionId: "session-1",
        userId: "user-1",
        displayName: "微信用户",
        memberships: [],
      },
      "phone-code",
    );
    expect(result).toEqual({
      phoneVerified: true,
      maskedPhone: "138****8000",
    });
    expect(crypto.encrypt).toHaveBeenCalledWith("13800138000");
    expect(JSON.stringify(auditCreate.mock.calls)).not.toContain(
      "13800138000",
    );
  });
});
