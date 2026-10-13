import { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";
import { AuthCryptoService } from "./auth-crypto.service.js";
import { TrustedDeviceService } from "./trusted-device.service.js";
import type { PrismaService } from "../database/prisma.service.js";
import type { AuthPrincipal } from "./auth.types.js";

const now = new Date("2026-10-13T16:00:00.000Z");
const agent = "Test Browser/1.0";
const actor: AuthPrincipal = {
  userId: "staff-a",
  sessionId: "session-a",
  displayName: "Staff",
  memberships: [{ organizationId: "org-a", role: "OPERATOR" }],
};
function fixture(settings: Record<string, string> = {}) {
  const config = new ConfigService({
    NODE_ENV: "test",
    AUTH_PROVIDER: "mock",
    STAFF_TRUSTED_DEVICE_ENABLED: "true",
    AUTH_SESSION_PEPPER:
      "test-only-trusted-device-pepper-at-least-32-characters",
    DATA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 1).toString("base64"),
    ...settings,
  });
  const crypto = new AuthCryptoService(config as never);
  const user = {
    id: actor.userId,
    status: "ACTIVE",
    phoneEncrypted: crypto.encrypt("13800000000"),
    phoneVerifiedAt: new Date(now.getTime() - 60_000),
    memberships: [{ role: "OPERATOR", status: "ACTIVE" }],
  };
  const session: any = {
    id: actor.sessionId,
    userId: actor.userId,
    revokedAt: null,
    createdAt: new Date(now.getTime() - 60_000),
    expiresAt: new Date(now.getTime() + 3_600_000),
    authChannel: "ADMIN_BROWSER",
    authProvider: "mock",
    mfaVerifiedUntil: new Date(now.getTime() + 300_000),
    staffVerifiedUntil: null,
    staffVerificationMethod: null,
    staffPasswordVersion: null,
    trustedDeviceId: null,
  };
  const mfa: any = { enabledAt: new Date(now.getTime() - 86_400_000) };
  let password: any = null;
  const devices: any[] = [];
  const tx: any = {
    $queryRaw: vi.fn(async () => []),
    user: { findUnique: vi.fn(async () => user) },
    session: {
      findUnique: vi.fn(async () => session),
      update: vi.fn(async ({ data }: any) => Object.assign(session, data)),
      updateMany: vi.fn(async ({ data }: any) => {
        Object.assign(session, data);
        return { count: 1 };
      }),
    },
    mfaCredential: { findUnique: vi.fn(async () => mfa) },
    staffPasswordCredential: { findUnique: vi.fn(async () => password) },
    staffTrustedDevice: {
      count: vi.fn(
        async () =>
          devices.filter((row) => !row.revokedAt && row.expiresAt > now).length,
      ),
      create: vi.fn(async ({ data }: any) => {
        const row = {
          id: `device-${devices.length + 1}`,
          lastUsedAt: null,
          revokedAt: null,
          ...data,
        };
        devices.push(row);
        return row;
      }),
      findUnique: vi.fn(
        async ({ where }: any) =>
          devices.find((row) =>
            where.id ? row.id === where.id : row.tokenHash === where.tokenHash,
          ) ?? null,
      ),
      findMany: vi.fn(async () => devices),
      update: vi.fn(async ({ where, data }: any) =>
        Object.assign(devices.find((row) => row.id === where.id)!, data),
      ),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  };
  const prisma = { ...tx, $transaction: vi.fn(async (cb: any) => cb(tx)) };
  return {
    service: new TrustedDeviceService(
      prisma as unknown as PrismaService,
      crypto,
      config,
    ),
    crypto,
    tx,
    prisma,
    user,
    session,
    mfa,
    devices,
    setPassword(value: any) {
      password = value;
    },
  };
}
async function registered(f = fixture()) {
  const issued = await f.service.register(actor, "我的电脑", agent, now);
  return { ...f, issued, device: f.devices[0]! };
}

describe("staff trusted device boundaries", () => {
  it("is opt in and cannot be enabled for Mock production authentication", () => {
    expect(
      fixture({
        STAFF_TRUSTED_DEVICE_ENABLED: "false",
      }).service.configuration(),
    ).toEqual({ enabled: false, maxDays: 7 });
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
  it("fails closed before issuing devices when disabled", async () => {
    const f = fixture({ STAFF_TRUSTED_DEVICE_ENABLED: "false" });
    await expect(
      f.service.register(actor, undefined, agent, now),
    ).rejects.toThrow("尚未开放");
    expect(f.tx.staffTrustedDevice.create).not.toHaveBeenCalled();
    await expect(
      f.service.accept(actor, "a".repeat(43), agent, now),
    ).rejects.toThrow("尚未开放");
  });
  it("issues a 32-byte random capability, stores only hashes, and fixes seven-day expiry", async () => {
    const f = await registered();
    expect(f.issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(f.device.tokenHash).toBe(
      f.crypto.hashBrowserLogin("trusted-device-token", f.issued.token),
    );
    expect(f.device.userAgentHash).toBe(
      f.crypto.hashBrowserLogin("trusted-device-agent", agent),
    );
    expect(f.device.expiresAt.getTime() - f.device.createdAt.getTime()).toBe(
      604_800_000,
    );
    expect(f.device.passwordVersion).toBe(0);
    expect(f.device.phoneHash).toBe(
      f.crypto.hashPhoneVerification("phone", "13800000000"),
    );
    expect(f.device.mfaEnabledAtSnapshot).toEqual(f.mfa.enabledAt);
    expect(
      JSON.stringify(f.tx.staffTrustedDevice.create.mock.calls),
    ).not.toContain(f.issued.token);
    expect(JSON.stringify(f.issued.device)).not.toContain("Hash");
    expect(JSON.stringify(f.tx.auditLog.create.mock.calls)).not.toContain(
      f.issued.token,
    );
    expect(JSON.stringify(f.tx.auditLog.create.mock.calls)).not.toContain(
      "13800000000",
    );
    expect(JSON.stringify(f.tx.auditLog.create.mock.calls)).not.toContain(
      agent,
    );
  });
  it("uses current DB TOTP assurance rather than trusting a forged principal", async () => {
    const f = fixture();
    f.session.mfaVerifiedUntil = null;
    await expect(
      f.service.register(
        { ...actor, mfaVerifiedUntil: new Date(now.getTime() + 300_000) },
        undefined,
        agent,
        now,
      ),
    ).rejects.toThrow("动态码验证");
    expect(f.tx.staffTrustedDevice.create).not.toHaveBeenCalled();
  });
  it("caps active registrations under the User lock rather than issuing unlimited trusted capabilities", async () => {
    const f = fixture();
    f.tx.staffTrustedDevice.count.mockResolvedValue(10);
    await expect(
      f.service.register(actor, undefined, agent, now),
    ).rejects.toThrow("最多保留10台");
    expect(f.tx.staffTrustedDevice.create).not.toHaveBeenCalled();
    expect(f.tx.staffTrustedDevice.count.mock.calls[0][0]).toEqual({
      where: { userId: actor.userId, revokedAt: null, expiresAt: { gt: now } },
    });
    expect(f.tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      f.tx.staffTrustedDevice.count.mock.invocationCallOrder[0],
    );
  });
  it.each([
    [
      "expired TOTP",
      (f: ReturnType<typeof fixture>) => {
        f.session.mfaVerifiedUntil = now;
      },
    ],
    [
      "missing active factor",
      (f: ReturnType<typeof fixture>) => {
        f.mfa.enabledAt = null;
      },
    ],
    [
      "revoked session",
      (f: ReturnType<typeof fixture>) => {
        f.session.revokedAt = now;
      },
    ],
    [
      "expired session",
      (f: ReturnType<typeof fixture>) => {
        f.session.expiresAt = now;
      },
    ],
    [
      "future session",
      (f: ReturnType<typeof fixture>) => {
        f.session.createdAt = new Date(now.getTime() + 1);
      },
    ],
    [
      "miniapp instead of browser",
      (f: ReturnType<typeof fixture>) => {
        f.session.authChannel = "WECHAT_MINIAPP";
      },
    ],
    [
      "deactivated user",
      (f: ReturnType<typeof fixture>) => {
        f.user.status = "DISABLED";
      },
    ],
    [
      "membership removed",
      (f: ReturnType<typeof fixture>) => {
        f.user.memberships = [];
      },
    ],
    [
      "only customer membership",
      (f: ReturnType<typeof fixture>) => {
        f.user.memberships = [{ role: "CUSTOMER", status: "ACTIVE" }];
      },
    ],
    [
      "missing phone proof",
      (f: ReturnType<typeof fixture>) => {
        f.user.phoneVerifiedAt = null as never;
      },
    ],
    [
      "unreadable phone",
      (f: ReturnType<typeof fixture>) => {
        f.user.phoneEncrypted = "invalid-ciphertext";
      },
    ],
  ])("does not register with %s", async (_label, mutate) => {
    const f = fixture();
    mutate(f);
    await expect(
      f.service.register(actor, undefined, agent, now),
    ).rejects.toThrow();
    expect(f.tx.staffTrustedDevice.create).not.toHaveBeenCalled();
  });
  it("takes User then Session locks before checking current credentials", async () => {
    const f = await registered();
    const sql = f.tx.$queryRaw.mock.calls.map((call: any) => call[0].join("?"));
    expect(sql[0]).toContain('FROM "User"');
    expect(sql[1]).toContain('FROM "Session"');
    expect(
      f.tx.user.findUnique.mock.calls[0][0].include.memberships.where,
    ).toEqual({ status: "ACTIVE" });
  });
  it("accepts only with new first factor, preserves TOTP and never slides device expiry", async () => {
    const f = await registered();
    const expiry = f.device.expiresAt.getTime();
    f.session.mfaVerifiedUntil = null;
    const result = await f.service.accept(actor, f.issued.token, agent, now);
    expect(result).toEqual({
      trusted: true,
      verifiedUntil: f.session.expiresAt.toISOString(),
    });
    expect(f.session.staffVerificationMethod).toBe("TRUSTED_DEVICE");
    expect(f.session.trustedDeviceId).toBe(f.device.id);
    expect(f.session.mfaVerifiedUntil).toBeNull();
    expect(f.tx.session.update.mock.calls[0][0].data).not.toHaveProperty(
      "mfaVerifiedUntil",
    );
    await f.service.accept(
      actor,
      f.issued.token,
      agent,
      new Date(now.getTime() + 60_000),
    );
    expect(f.device.expiresAt.getTime()).toBe(expiry);
    expect(
      f.tx.staffTrustedDevice.update.mock.calls.every(
        (call: any) => !Object.hasOwn(call[0].data, "expiresAt"),
      ),
    ).toBe(true);
  });
  it("accepts after password first factor without converting it into TOTP", async () => {
    const f = fixture();
    f.setPassword({ version: 2 });
    f.session.staffPasswordVersion = 2;
    const saved = await registered(f);
    saved.session.mfaVerifiedUntil = null;
    saved.session.staffVerificationMethod = "PASSWORD_SMS";
    expect(
      (await saved.service.accept(actor, saved.issued.token, agent, now))
        .trusted,
    ).toBe(true);
    expect(saved.session.mfaVerifiedUntil).toBeNull();
  });
  it("never grants login assurance beyond device expiry or extends it by repeated acceptance", async () => {
    const f = await registered();
    f.device.expiresAt = new Date(now.getTime() + 30_000);
    const expires = f.device.expiresAt.toISOString();
    expect(await f.service.accept(actor, f.issued.token, agent, now)).toEqual({
      trusted: true,
      verifiedUntil: expires,
    });
    expect(f.session.staffVerifiedUntil).toEqual(f.device.expiresAt);
    expect(
      await f.service.accept(
        actor,
        f.issued.token,
        agent,
        new Date(now.getTime() + 10_000),
      ),
    ).toEqual({ trusted: true, verifiedUntil: expires });
    expect(f.device.expiresAt.toISOString()).toBe(expires);
    expect(
      await f.service.validateSessionTrust(
        f.session,
        f.user,
        f.device.expiresAt,
      ),
    ).toBe(false);
  });
  it("does not accept old first-factor sessions or snapshots belonging to another session", async () => {
    const f = await registered();
    f.session.createdAt = new Date(now.getTime() - 300_001);
    await expect(
      f.service.accept(actor, f.issued.token, agent, now),
    ).rejects.toThrow("重新完成微信或密码登录");
    f.session.createdAt = now;
    f.session.userId = "another-user";
    await expect(
      f.service.accept(actor, f.issued.token, agent, now),
    ).rejects.toThrow("已失效");
    expect(f.tx.session.update).not.toHaveBeenCalled();
  });
  it.each([
    [
      "other owner",
      (f: Awaited<ReturnType<typeof registered>>) => {
        f.device.userId = "staff-b";
      },
    ],
    [
      "another browser",
      (f: Awaited<ReturnType<typeof registered>>) => {
        f.device.userAgentHash = "another-hash";
      },
    ],
    [
      "expired device",
      (f: Awaited<ReturnType<typeof registered>>) => {
        f.device.expiresAt = now;
      },
    ],
    [
      "future device",
      (f: Awaited<ReturnType<typeof registered>>) => {
        f.device.createdAt = new Date(now.getTime() + 1);
      },
    ],
    [
      "revoked device",
      (f: Awaited<ReturnType<typeof registered>>) => {
        f.device.revokedAt = now;
      },
    ],
    [
      "rebound MFA",
      (f: Awaited<ReturnType<typeof registered>>) => {
        f.mfa.enabledAt = now;
      },
    ],
    [
      "removed MFA",
      (f: Awaited<ReturnType<typeof registered>>) => {
        f.mfa.enabledAt = null;
      },
    ],
    [
      "changed password",
      (f: Awaited<ReturnType<typeof registered>>) => {
        f.setPassword({ version: 1 });
      },
    ],
    [
      "changed verified phone",
      (f: Awaited<ReturnType<typeof registered>>) => {
        f.user.phoneEncrypted = f.crypto.encrypt("13900000000");
      },
    ],
  ])("rejects device acceptance with %s", async (_label, mutate) => {
    const f = await registered();
    mutate(f);
    expect(await f.service.accept(actor, f.issued.token, agent, now)).toEqual({
      trusted: false,
    });
    expect(f.tx.session.update).not.toHaveBeenCalled();
  });
  it("rejects malformed and unknown bearer cookies without revealing the reason", async () => {
    const f = await registered();
    for (const token of [null, "x", "a".repeat(42), "a".repeat(43)])
      expect(await f.service.accept(actor, token, agent, now)).toEqual({
        trusted: false,
      });
    expect(f.tx.session.update).not.toHaveBeenCalled();
  });
  it("requires a bounded user agent for registration and acceptance", async () => {
    const f = await registered();
    for (const value of [undefined, "", "x".repeat(1025)]) {
      await expect(
        f.service.register(actor, undefined, value, now),
      ).rejects.toThrow("浏览器设备");
      await expect(
        f.service.accept(actor, f.issued.token, value, now),
      ).rejects.toThrow("浏览器设备");
    }
  });
  it("rechecks device snapshots and authoritative session state on every guarded request", async () => {
    const f = await registered();
    f.session.mfaVerifiedUntil = null;
    await f.service.accept(actor, f.issued.token, agent, now);
    const original = { ...f.session };
    expect(await f.service.validateSessionTrust(original, f.user, now)).toBe(
      true,
    );
    f.session.staffVerifiedUntil = null;
    expect(await f.service.validateSessionTrust(original, f.user, now)).toBe(
      false,
    );
    f.session.staffVerifiedUntil = original.staffVerifiedUntil;
    f.device.revokedAt = now;
    expect(await f.service.validateSessionTrust(original, f.user, now)).toBe(
      false,
    );
  });
  it.each([
    [
      "user deactivated",
      (f: Awaited<ReturnType<typeof registered>>) => {
        f.user.status = "DISABLED";
      },
    ],
    [
      "role revoked",
      (f: Awaited<ReturnType<typeof registered>>) => {
        f.user.memberships = [];
      },
    ],
    [
      "MFA rebound",
      (f: Awaited<ReturnType<typeof registered>>) => {
        f.mfa.enabledAt = now;
      },
    ],
    [
      "password changed",
      (f: Awaited<ReturnType<typeof registered>>) => {
        f.setPassword({ version: 1 });
      },
    ],
    [
      "phone changed",
      (f: Awaited<ReturnType<typeof registered>>) => {
        f.user.phoneEncrypted = f.crypto.encrypt("13900000000");
      },
    ],
    [
      "session revoked",
      (f: Awaited<ReturnType<typeof registered>>) => {
        f.session.revokedAt = now;
      },
    ],
    [
      "device expired",
      (f: Awaited<ReturnType<typeof registered>>) => {
        f.device.expiresAt = now;
      },
    ],
  ])(
    "invalidates established session trust after %s",
    async (_label, mutate) => {
      const f = await registered();
      await f.service.accept(actor, f.issued.token, agent, now);
      mutate(f);
      expect(await f.service.validateSessionTrust(f.session, f.user, now)).toBe(
        false,
      );
    },
  );
  it("cannot validate with a spoofed caller user ID or a non-trusted-device method", async () => {
    const f = await registered();
    await f.service.accept(actor, f.issued.token, agent, now);
    expect(
      await f.service.validateSessionTrust(f.session, { id: "staff-b" }, now),
    ).toBe(false);
    f.session.staffVerificationMethod = "TOTP";
    expect(await f.service.validateSessionTrust(f.session, f.user, now)).toBe(
      false,
    );
  });
  it("lists summaries only, and scopes the query to the authenticated owner", async () => {
    const f = await registered();
    const list = await f.service.list(actor, now);
    expect(f.tx.staffTrustedDevice.findMany.mock.calls[0][0].where).toEqual({
      userId: actor.userId,
    });
    expect(JSON.stringify(list)).not.toContain("Hash");
    expect(JSON.stringify(list)).not.toContain(f.issued.token);
    expect(JSON.stringify(list)).not.toContain(f.device.phoneHash);
  });
  it("allows owner revocation without a fresh TOTP and clears all linked login assurance", async () => {
    const f = await registered();
    await f.service.accept(actor, f.issued.token, agent, now);
    const snapshot = { ...f.session };
    f.session.mfaVerifiedUntil = null;
    await f.service.revoke(actor, f.device.id, now);
    expect(f.device.revokedAt).toEqual(now);
    expect(f.tx.session.updateMany.mock.calls[0][0]).toEqual({
      where: { userId: actor.userId, trustedDeviceId: f.device.id },
      data: {
        staffVerifiedUntil: null,
        staffVerificationMethod: null,
        trustedDeviceId: null,
      },
    });
    expect(await f.service.validateSessionTrust(snapshot, f.user, now)).toBe(
      false,
    );
    expect(await f.service.accept(actor, f.issued.token, agent, now)).toEqual({
      trusted: false,
    });
  });
  it("continues to permit security-tightening revocation if the feature is switched off", async () => {
    const f = fixture({ STAFF_TRUSTED_DEVICE_ENABLED: "false" });
    f.devices.push({
      id: "old-device",
      userId: actor.userId,
      label: "常用设备",
      createdAt: now,
      expiresAt: new Date(now.getTime() + 1000),
      revokedAt: null,
      lastUsedAt: null,
    });
    await expect(
      f.service.revoke(actor, "old-device", now),
    ).resolves.toHaveProperty("device.id", "old-device");
  });
  it("never revokes another staff user's device and does not duplicate revocation audits", async () => {
    const f = await registered();
    f.device.userId = "staff-b";
    await expect(f.service.revoke(actor, f.device.id, now)).rejects.toThrow(
      "不存在",
    );
    expect(f.tx.session.updateMany).not.toHaveBeenCalled();
    f.device.userId = actor.userId;
    await f.service.revoke(actor, f.device.id, now);
    const audits = f.tx.auditLog.create.mock.calls.length;
    await f.service.revoke(actor, f.device.id, now);
    expect(f.tx.auditLog.create).toHaveBeenCalledTimes(audits);
  });
  it("locks authoritative device state after User/Session to prevent stale acceptance after revoke", async () => {
    const f = await registered();
    f.tx.$queryRaw.mockClear();
    const originalLookup = f.tx.staffTrustedDevice.findUnique;
    originalLookup.mockImplementation(async ({ where }: any) => {
      if (where.tokenHash) return { ...f.device };
      return { ...f.device, revokedAt: now };
    });
    expect(await f.service.accept(actor, f.issued.token, agent, now)).toEqual({
      trusted: false,
    });
    const sql = f.tx.$queryRaw.mock.calls.map((call: any) => call[0].join("?"));
    expect(
      sql.map((statement: string) => statement.match(/FROM "([^"]+)"/)?.[1]),
    ).toEqual(["User", "Session", "StaffTrustedDevice"]);
    expect(f.tx.session.update).not.toHaveBeenCalled();
  });
});
