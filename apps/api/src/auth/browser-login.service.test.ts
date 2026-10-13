import { describe, it, expect, vi } from "vitest";
import { ConfigService } from "@nestjs/config";
import { AuthSessionSchema } from "@zydj/contracts";
import { BrowserLoginService } from "./browser-login.service.js";
import { AuthCryptoService } from "./auth-crypto.service.js";
import type { PrismaService } from "../database/prisma.service.js";
function fixture(values: Record<string, string> = {}) {
  const config = new ConfigService({
    NODE_ENV: "test",
    AUTH_PROVIDER: "mock",
    STAFF_BROWSER_LOGIN_ENABLED: "true",
    CORS_ORIGINS: "https://admin.example.com,http://127.0.0.1:5173",
    AUTH_SESSION_PEPPER: "test-pepper-of-at-least-thirty-two-chars",
    DATA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 1).toString("base64"),
    ...values,
  });
  const crypto = new AuthCryptoService(config as never);
  const db = {
    browserLoginRateLimit: {
      upsert: vi.fn(async () => ({ count: 1 })),
      deleteMany: vi.fn(),
    },
    browserLoginChallenge: { create: vi.fn(), deleteMany: vi.fn() },
  };
  return {
    service: new BrowserLoginService(
      db as unknown as PrismaService,
      crypto,
      config,
    ),
    crypto,
    config,
    db,
  };
}
describe("browser login boundaries", () => {
  it("is explicitly opt in", async () => {
    const f = fixture({ STAFF_BROWSER_LOGIN_ENABLED: "false" });
    expect(f.service.configuration().enabled).toBe(false);
    await expect(f.service.create("peer")).rejects.toThrow();
    expect(f.db.browserLoginChallenge.create).not.toHaveBeenCalled();
  });
  it("cannot accept Mock production first factor", () => {
    expect(
      fixture({ NODE_ENV: "production" }).service.configuration().enabled,
    ).toBe(false);
    expect(
      fixture({
        NODE_ENV: "production",
        AUTH_PROVIDER: "wechat",
      }).service.configuration().enabled,
    ).toBe(true);
  });
  it("requires exact HTTPS origin in production", () => {
    const { service } = fixture({
      NODE_ENV: "production",
      AUTH_PROVIDER: "wechat",
    });
    expect(() => service.assertBrowserOrigin()).toThrow();
    expect(() =>
      service.assertBrowserOrigin("http://127.0.0.1:5173"),
    ).toThrow();
    expect(() =>
      service.assertBrowserOrigin("https://evil.example.com"),
    ).toThrow();
    expect(() =>
      service.assertBrowserOrigin("https://admin.example.com"),
    ).not.toThrow();
  });
  it("rejects arbitrary origins also in test mode", () => {
    expect(() =>
      fixture().service.assertBrowserOrigin("https://evil.example.com"),
    ).toThrow();
  });
  it("only stores domain-separated hashes and fixed three-minute expiry", async () => {
    const f = fixture(),
      now = new Date("2026-10-04T00:00:00Z");
    const r = await f.service.create("private-peer", now);
    expect(r.pairCode).toMatch(/^[\w-]{22}$/);
    expect(r.browserSecret).toMatch(/^[\w-]{43}$/);
    expect(r.confirmationCode).toMatch(/^\d{6}$/);
    expect(Date.parse(r.expiresAt) - now.getTime()).toBe(180000);
    const stored = f.db.browserLoginChallenge.create.mock
      .calls[0] as unknown as [{ data: Record<string, unknown> }];
    expect(stored[0].data.browserSecretHash).toBe(
      f.crypto.hashBrowserLogin("device", r.browserSecret),
    );
    expect(JSON.stringify(stored)).not.toContain(r.browserSecret);
    expect(JSON.stringify(stored)).not.toContain(r.confirmationCode);
    expect(
      JSON.stringify(f.db.browserLoginRateLimit.upsert.mock.calls),
    ).not.toContain("private-peer");
  });
  it("blocks globally before peer row or challenge creation", async () => {
    const f = fixture();
    f.db.browserLoginRateLimit.upsert.mockResolvedValue({ count: 1001 });
    await expect(f.service.create("peer")).rejects.toMatchObject({
      status: 429,
    });
    expect(f.db.browserLoginRateLimit.upsert).toHaveBeenCalledTimes(1);
    expect(f.db.browserLoginChallenge.create).not.toHaveBeenCalled();
  });
  it("peer rate cap applies independently of global cap", async () => {
    const f = fixture();
    f.db.browserLoginRateLimit.upsert
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 61 });
    await expect(f.service.create("peer")).rejects.toMatchObject({
      status: 429,
    });
    expect(f.db.browserLoginChallenge.create).not.toHaveBeenCalled();
  });
  it("does not prune permanent sessions or audit records", async () => {
    const f = fixture();
    await f.service.create("peer");
    expect(f.db.browserLoginChallenge.deleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lt: expect.any(Date) } },
    });
    expect(f.db.browserLoginRateLimit.deleteMany).toHaveBeenCalled();
  });
  it.each([true, false])(
    "claims a contract-compatible browser session with phoneVerified=%s",
    async (phoneVerified) => {
      const f = fixture();
      const now = new Date("2026-10-13T12:00:00Z");
      const browserSecret = f.crypto.createSessionToken();
      const sourceSession = {
        id: "source-session",
        userId: "staff-user",
        authChannel: "WECHAT_MINIAPP",
        authProvider: "mock",
        revokedAt: null,
        createdAt: now,
        expiresAt: new Date(now.getTime() + 600_000),
      };
      const user = {
        id: sourceSession.userId,
        status: "ACTIVE",
        displayName: "Authorized staff fixture",
        phoneEncrypted: phoneVerified ? "encrypted-fixture-phone" : null,
        phoneVerifiedAt: phoneVerified ? now : null,
        memberships: [
          { organizationId: "staff-org", role: "OPERATOR", status: "ACTIVE" },
        ],
      };
      const challenge = {
        id: "fixture-pair-code",
        status: "APPROVED",
        approvedUserId: user.id,
        approvedSessionId: sourceSession.id,
        browserSecretHash: f.crypto.hashBrowserLogin("device", browserSecret),
        expiresAt: new Date(now.getTime() + 180_000),
      };
      const database = {
        ...f.db,
        $queryRaw: vi.fn(async () => []),
        user: { findUnique: vi.fn(async () => user) },
        session: {
          findUnique: vi.fn(async () => sourceSession),
          create: vi.fn(async () => ({ id: "claimed-browser-session" })),
        },
        browserLoginChallenge: {
          ...f.db.browserLoginChallenge,
          findUnique: vi.fn(async () => challenge),
          update: vi.fn(async () => ({})),
        },
        auditLog: { create: vi.fn(async () => ({})) },
      };
      const transaction = {
        ...database,
        $transaction: vi.fn(async (run: (tx: typeof database) => unknown) => run(database)),
      };
      const service = new BrowserLoginService(
        transaction as unknown as PrismaService,
        f.crypto,
        f.config,
      );
      const session = await service.claim(challenge.id, browserSecret, now);
      expect(AuthSessionSchema.parse(session).user.phoneVerified).toBe(phoneVerified);
      expect(database.session.create).toHaveBeenCalledTimes(1);
    },
  );
});
