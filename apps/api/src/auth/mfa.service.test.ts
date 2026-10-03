import { ConfigService } from "@nestjs/config";
import { describe, it, expect, vi } from "vitest";
import { MfaService } from "./mfa.service.js";
import { AuthCryptoService } from "./auth-crypto.service.js";
import { encodeBase32, hotp } from "./totp.js";
import type { PrismaService } from "../database/prisma.service.js";
const now = new Date("2026-10-04T00:00:00Z"),
  key = Buffer.from("12345678901234567890"),
  secret = encodeBase32(key),
  step = BigInt(now.getTime() / 30_000);
const principal = {
  sessionId: "session-a",
  userId: "user-a",
  displayName: "test",
  memberships: [{ organizationId: "org-a", role: "OPERATOR" as const }],
};
function fixture(active = true) {
  const config = new ConfigService({
    DATA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 1).toString("base64"),
    AUTH_SESSION_PEPPER: "test-only-pepper-with-at-least-32-chars",
    NODE_ENV: "test",
  });
  const crypto = new AuthCryptoService(config as never);
  const credential = {
    userId: "user-a",
    secretEncrypted: crypto.encrypt(secret),
    enabledAt: active ? new Date(now.getTime() - 60_000) : null,
    enrollmentSessionId: active ? null : "session-a",
    enrollmentExpiresAt: active ? null : new Date(now.getTime() + 600_000),
    lastAcceptedStep: active ? step - 1n : null,
    failedAttempts: 0,
    lockedUntil: null as Date | null,
  };
  const session = {
    id: "session-a",
    userId: "user-a",
    revokedAt: null as Date | null,
    createdAt: now,
    expiresAt: new Date(now.getTime() + 3600_000),
  };
  const user = {
    id: "user-a",
    status: "ACTIVE",
    memberships: [{ role: "OPERATOR" }],
  };
  const tx = {
    $queryRaw: vi.fn(),
    user: { findUnique: vi.fn(async () => user) },
    session: {
      findUnique: vi.fn(async () => session),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    mfaCredential: {
      findUnique: vi.fn(async () => credential),
      upsert: vi.fn(),
      update: vi.fn(async ({ data }: any) => Object.assign(credential, data)),
    },
    auditLog: { create: vi.fn() },
  };
  const prisma = { ...tx, $transaction: vi.fn(async (cb: any) => cb(tx)) };
  return {
    service: new MfaService(prisma as unknown as PrismaService, crypto, config),
    tx,
    credential,
    session,
    user,
    crypto,
  };
}
describe("staff MFA persistence", () => {
  it("activates only the enrollment owner and encrypts the stored secret", async () => {
    const f = fixture(false);
    const result = await f.service.verify(
      principal,
      hotp(key, step),
      true,
      now,
    );
    expect(result.verifiedUntil).toBe(
      new Date(now.getTime() + 300_000).toISOString(),
    );
    expect(f.credential.lastAcceptedStep).toBe(step);
    expect(f.credential.enabledAt).toEqual(now);
    expect(f.credential.secretEncrypted).not.toContain(secret);
    expect(JSON.stringify(f.tx.auditLog.create.mock.calls)).not.toContain(
      secret,
    );
  });
  it("rejects a pending enrollment from another session", async () => {
    const f = fixture(false);
    f.credential.enrollmentSessionId = "other";
    await expect(
      f.service.verify(principal, hotp(key, step), true, now),
    ).rejects.toThrow("不属于");
    expect(f.tx.session.updateMany).not.toHaveBeenCalled();
  });
  it("rejects expired enrollment", async () => {
    const f = fixture(false);
    f.credential.enrollmentExpiresAt = new Date(now.getTime() - 1);
    await expect(
      f.service.verify(principal, hotp(key, step), true, now),
    ).rejects.toThrow("过期");
  });
  it("persists a failure and locks at five instead of rolling it back", async () => {
    const f = fixture();
    const wrong = hotp(key, step) === "000000" ? "999999" : "000000";
    for (let i = 0; i < 5; i++)
      await expect(
        f.service.verify(principal, wrong, false, now),
      ).rejects.toThrow();
    expect(f.credential.failedAttempts).toBe(5);
    expect(f.credential.lockedUntil).toEqual(new Date(now.getTime() + 300_000));
    await expect(
      f.service.verify(principal, hotp(key, step), false, now),
    ).rejects.toThrow("锁定");
    expect(f.tx.session.updateMany).not.toHaveBeenCalled();
  });
  it("resets only an expired lock on valid verification", async () => {
    const f = fixture();
    f.credential.failedAttempts = 5;
    f.credential.lockedUntil = new Date(now.getTime() - 1);
    await f.service.verify(principal, hotp(key, step), false, now);
    expect(f.credential.failedAttempts).toBe(0);
    expect(f.credential.lockedUntil).toBeNull();
  });
  it("counts a wrong guess after a lock expires from one", async () => {
    const f = fixture();
    f.credential.failedAttempts = 5;
    f.credential.lockedUntil = new Date(now.getTime() - 1);
    await expect(
      f.service.verify(principal, "000000", false, now),
    ).rejects.toThrow();
    expect(f.credential.failedAttempts).toBe(1);
  });
  it("rejects replay on another session", async () => {
    const f = fixture();
    await f.service.verify(principal, hotp(key, step), false, now);
    await expect(
      f.service.verify(principal, hotp(key, step), false, now),
    ).rejects.toThrow("已被使用");
    expect(f.tx.session.updateMany).toHaveBeenCalledTimes(1);
  });
  it("caps MFA at the actual session expiry", async () => {
    const f = fixture();
    f.session.expiresAt = new Date(now.getTime() + 50_000);
    const result = await f.service.verify(
      principal,
      hotp(key, step),
      false,
      now,
    );
    expect(result.verifiedUntil).toBe(f.session.expiresAt.toISOString());
  });
  it("does not allow enrollment to replace an active factor", async () => {
    const f = fixture();
    await expect(f.service.enroll(principal, now)).rejects.toThrow("禁止");
    expect(f.tx.mfaCredential.upsert).not.toHaveBeenCalled();
  });
  it("requires a fresh login for enrollment", async () => {
    const f = fixture(false);
    f.session.createdAt = new Date(now.getTime() - 300_001);
    await expect(f.service.enroll(principal, now)).rejects.toThrow("重新");
  });
  it("rejects a customer or a disabled account", async () => {
    const f = fixture();
    f.user.memberships = [];
    await expect(
      f.service.verify(principal, hotp(key, step), false, now),
    ).rejects.toThrow("授权");
    f.user.status = "DISABLED";
    await expect(
      f.service.verify(principal, hotp(key, step), false, now),
    ).rejects.toThrow("失效");
  });
  it("rejects revoked and concurrently revoked sessions", async () => {
    const f = fixture();
    f.session.revokedAt = now;
    await expect(
      f.service.verify(principal, hotp(key, step), false, now),
    ).rejects.toThrow("失效");
    f.session.revokedAt = null;
    f.tx.session.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      f.service.verify(principal, hotp(key, step), false, now),
    ).rejects.toThrow("失效");
    expect(f.tx.mfaCredential.update).not.toHaveBeenCalled();
  });
  it("does not expose encrypted or raw secrets from status", async () => {
    const f = fixture();
    const text = JSON.stringify(await f.service.status(principal));
    expect(text).not.toContain(secret);
    expect(text).not.toContain(f.credential.secretEncrypted);
  });
  it("returns a new secret once when an expired binding is replaced", async () => {
    const f = fixture(false);
    f.credential.enrollmentExpiresAt = new Date(now.getTime() - 1);
    const result = await f.service.enroll(principal, now);
    expect(result.secret).toMatch(/^[A-Z2-7]{32}$/);
    const data = f.tx.mfaCredential.upsert.mock.calls[0]![0] as any;
    expect(f.crypto.decrypt(data.create.secretEncrypted)).toBe(result.secret);
    expect(JSON.stringify(f.tx.auditLog.create.mock.calls)).not.toContain(
      result.secret,
    );
  });
});
