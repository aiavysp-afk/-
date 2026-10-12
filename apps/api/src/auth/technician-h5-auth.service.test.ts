import { ConfigService } from "@nestjs/config";
import { UnauthorizedException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../config/env.js";
import { TechnicianH5AuthService } from "./technician-h5-auth.service.js";

const configuration = () =>
  new ConfigService({
    TECHNICIAN_H5_ENTRY_URL: "https://mtsc.top/technician/onboarding/",
  }) as ConfigService<AppEnv, true>;

describe("TechnicianH5AuthService", () => {
  it("binds OAuth state to the initiating browser and issues no session token in the redirect", async () => {
    let issuedState = "";
    const stateCreate = vi.fn().mockResolvedValue({ id: "state" });
    const ticketCreate = vi.fn().mockResolvedValue({ id: "ticket" });
    const prisma = {
      technicianH5OAuthState: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: stateCreate,
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      technicianH5LoginTicket: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: ticketCreate,
      },
      auditLog: { create: vi.fn().mockResolvedValue({ id: "audit" }) },
      $transaction: vi.fn(async (value: unknown) => {
        if (Array.isArray(value)) return Promise.all(value);
        throw new Error("unexpected transaction shape");
      }),
    };
    const crypto = {
      hashBrowserLogin: vi.fn((purpose: string, value: string) =>
        `${purpose}:${value}`,
      ),
    };
    const auth = {
      identifyWechatH5: vi.fn().mockResolvedValue("user-1"),
    };
    const wechat = {
      authorizeUrl: vi.fn((state: string) => {
        issuedState = state;
        return `https://open.weixin.qq.com/oauth?state=${state}`;
      }),
      exchangeOauthCode: vi.fn().mockResolvedValue({
        openId: "openid-1",
        unionId: "unionid-1",
      }),
    };
    const service = new TechnicianH5AuthService(
      prisma as never,
      crypto as never,
      auth as never,
      wechat as never,
      configuration(),
    );

    const start = await service.begin();
    expect(start.authorizeUrl).toContain(issuedState);
    expect(stateCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        stateHash: `technician-h5:state:${issuedState}`,
        browserBindingHash: `technician-h5:browser:${start.browserBinding}`,
      }),
    });

    const redirect = await service.callback(
      "c".repeat(32),
      issuedState,
      start.browserBinding,
    );
    expect(redirect).toMatch(
      /^https:\/\/mtsc\.top\/technician\/onboarding\/#\/wechat-callback\?ticket=/,
    );
    expect(redirect).not.toContain("session");
    expect(auth.identifyWechatH5).toHaveBeenCalledWith({
      openId: "openid-1",
      unionId: "unionid-1",
    });
    expect(ticketCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: "user-1" }),
    });
  });

  it("rejects a callback whose state is missing, expired, replayed, or from another browser", async () => {
    const prisma = {
      technicianH5OAuthState: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const wechat = { exchangeOauthCode: vi.fn() };
    const service = new TechnicianH5AuthService(
      prisma as never,
      {
        hashBrowserLogin: vi.fn((purpose: string, value: string) =>
          `${purpose}:${value}`,
        ),
      } as never,
      {} as never,
      wechat as never,
      configuration(),
    );

    await expect(
      service.callback("c".repeat(32), "s".repeat(43), "b".repeat(43)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(wechat.exchangeOauthCode).not.toHaveBeenCalled();
  });

  it("consumes a login ticket exactly once before minting an ordinary bearer session", async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const prisma = {
      technicianH5LoginTicket: {
        findUnique: vi.fn().mockResolvedValue({
          id: "ticket-row",
          userId: "user-1",
          expiresAt,
          consumedAt: null,
        }),
        updateMany: vi
          .fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 0 }),
      },
    };
    const auth = {
      createSessionForUser: vi.fn().mockResolvedValue({
        accessToken: "opaque-access-token",
        expiresAt: expiresAt.toISOString(),
        user: {
          id: "user-1",
          displayName: "微信用户",
          phoneVerified: false,
          memberships: [],
        },
      }),
    };
    const service = new TechnicianH5AuthService(
      prisma as never,
      {
        hashBrowserLogin: vi.fn((purpose: string, value: string) =>
          `${purpose}:${value}`,
        ),
      } as never,
      auth as never,
      {} as never,
      configuration(),
    );

    await expect(service.exchange("t".repeat(43))).resolves.toMatchObject({
      accessToken: "opaque-access-token",
    });
    await expect(service.exchange("t".repeat(43))).rejects.toThrow(
      "票据状态已变化",
    );
    expect(auth.createSessionForUser).toHaveBeenCalledTimes(1);
    expect(auth.createSessionForUser).toHaveBeenCalledWith(
      "user-1",
      "WECHAT_H5",
    );
  });
});
