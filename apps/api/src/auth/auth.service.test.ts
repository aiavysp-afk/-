import { ConfigService } from "@nestjs/config";
import { UserRole } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../config/env.js";
import type { PrismaService } from "../database/prisma.service.js";
import type { AuthCryptoService } from "./auth-crypto.service.js";
import { AuthService } from "./auth.service.js";
import type { WechatMiniappClient } from "./wechat-miniapp.client.js";

describe("AuthService", () => {
  it("creates every new miniapp identity as a customer and returns only an opaque session token", async () => {
    const tx = {
      externalIdentity: {
        upsert: vi.fn().mockResolvedValue({
          user: {
            id: "user-1",
            status: "ACTIVE",
            displayName: "微信用户",
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
  });
});
