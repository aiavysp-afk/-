import { describe, expect, it, vi } from "vitest";
import { ConfigService } from "@nestjs/config";
import { AuthSessionSchema } from "@zydj/contracts";
import { StaffPasswordService } from "./staff-password.service.js";
import { AuthCryptoService } from "./auth-crypto.service.js";
import { BrowserLoginService } from "./browser-login.service.js";
import type { AuthPrincipal } from "./auth.types.js";
import { verifyStaffPassword } from "./password-hash.js";

vi.mock("./password-hash.js", async (importActual) => ({
  ...(await importActual<typeof import("./password-hash.js")>()),
  hashStaffPassword: vi.fn(async () => "scrypt-test-hash"),
  verifyStaffPassword: vi.fn(
    async (password: string) => password === "correct-password",
  ),
}));

const NOW = new Date("2026-10-13T12:00:00Z");
const principal: AuthPrincipal = {
  sessionId: "session-1",
  userId: "user-1",
  displayName: "staff",
  authChannel: "ADMIN_BROWSER",
  memberships: [{ organizationId: "org-1", role: "OPERATOR" }],
};
function fixture(values: Record<string, string> = {}) {
  const config = new ConfigService({
    NODE_ENV: "test",
    AUTH_PROVIDER: "wechat",
    STAFF_PASSWORD_LOGIN_ENABLED: "true",
    CORS_ORIGINS: "https://admin.example.com",
    SMS_PROVIDER: "aliyun",
    SMS_SEND_ENABLED: "true",
    PHONE_VERIFICATION_SMS_ENABLED: "true",
    ALIYUN_SMS_ACCESS_KEY_ID: "non-production-test-id",
    ALIYUN_SMS_ACCESS_KEY_SECRET: "non-production-test-secret",
    ALIYUN_SMS_SIGN_NAME: "TestSign",
    ALIYUN_SMS_PHONE_VERIFICATION_TEMPLATE_CODE: "SMS_TEST",
    AUTH_SESSION_PEPPER: "test-pepper-of-at-least-thirty-two-chars",
    DATA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 1).toString("base64"),
    ...values,
  });
  const crypto = new AuthCryptoService(config as never);
  const user = {
    id: "user-1",
    status: "ACTIVE",
    displayName: "staff",
    phoneVerifiedAt: NOW,
    phoneEncrypted: crypto.encrypt("13800001234"),
    memberships: [
      { organizationId: "org-1", role: "OPERATOR", status: "ACTIVE" },
    ],
  };
  const credential = {
    userId: user.id,
    phoneHash: crypto.hashPhoneVerification("phone", "13800001234"),
    passwordHash: "existing-hash",
    version: 1,
    failedAttempts: 0,
    lockedUntil: null as Date | null,
    updatedAt: NOW,
  };
  const session = {
    id: "session-1",
    userId: user.id,
    authChannel: "ADMIN_BROWSER",
    authProvider: "wechat",
    expiresAt: new Date(NOW.getTime() + 3_600_000),
    createdAt: NOW,
    revokedAt: null,
    mfaVerifiedUntil: new Date(NOW.getTime() + 60_000) as Date | null,
  };
  const rows = new Map<string, any>();
  const db: any = {
    $queryRaw: vi.fn(async () => []),
    browserLoginRateLimit: { upsert: vi.fn(async () => ({ count: 1 })) },
    user: { findUnique: vi.fn(async () => user) },
    staffPasswordCredential: {
      findUnique: vi.fn(async () => credential),
      update: vi.fn(async (input: any) => {
        Object.assign(credential, input.data);
        return credential;
      }),
      upsert: vi.fn(async () => ({
        ...credential,
        version: credential.version + 1,
      })),
    },
    staffPasswordLoginChallenge: {
      create: vi.fn(async ({ data }: any) => {
        const row = { ...data, attempts: 0, consumedAt: null };
        rows.set(data.id, row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: any) => rows.get(where.id) ?? null),
      findFirst: vi.fn(async () => null),
      update: vi.fn(async ({ where, data }: any) => {
        const row = rows.get(where.id);
        Object.assign(row, data);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (!where.id) return { count: 1 };
        const row = rows.get(where.id);
        if (
          !row ||
          (where.status === "PENDING" && row.status !== "PENDING") ||
          row.consumedAt
        )
          return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    session: {
      findUnique: vi.fn(async () => session),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async () => session),
      create: vi.fn(async () => ({ id: "new-session" })),
    },
    staffTrustedDevice: { updateMany: vi.fn(async () => ({ count: 1 })) },
    auditLog: { create: vi.fn(async () => ({})) },
  };
  db.$transaction = vi.fn(async (callback: any) => callback(db));
  const sms = {
    submitPhoneVerification: vi.fn(async () => ({
      status: "ACCEPTED",
      requestId: "provider-request",
      bizId: "provider-biz",
    })),
  };
  const browser = new BrowserLoginService(db, crypto, config);
  const service = new StaffPasswordService(
    db,
    crypto,
    config,
    sms as never,
    browser,
  );
  async function issue() {
    const challenge = await service.login(
      { account: "13800001234", password: "correct-password" },
      "socket-peer",
      NOW,
    );
    const sent = sms.submitPhoneVerification.mock.calls[0] as unknown as [
      { code: string },
    ];
    return { ...challenge, code: sent[0].code };
  }
  return { service, db, sms, crypto, user, credential, session, rows, issue };
}

describe("staff password configuration and caller boundaries", () => {
  it("is opt-in and fails closed before DB reads or SMS", async () => {
    const f = fixture({ STAFF_PASSWORD_LOGIN_ENABLED: "false" });
    expect(f.service.configuration()).toEqual({
      enabled: false,
      smsEnabled: false,
    });
    await expect(f.issue()).rejects.toMatchObject({ status: 503 });
    expect(f.db.staffPasswordCredential.findUnique).not.toHaveBeenCalled();
    expect(f.sms.submitPhoneVerification).not.toHaveBeenCalled();
  });
  it.each([
    "SMS_SEND_ENABLED",
    "PHONE_VERIFICATION_SMS_ENABLED",
    "ALIYUN_SMS_ACCESS_KEY_ID",
    "ALIYUN_SMS_ACCESS_KEY_SECRET",
    "ALIYUN_SMS_SIGN_NAME",
    "ALIYUN_SMS_PHONE_VERIFICATION_TEMPLATE_CODE",
  ])("fails closed for missing %s", async (field) => {
    const f = fixture({ [field]: "" });
    expect(f.service.configuration()).toEqual({
      enabled: true,
      smsEnabled: false,
    });
    await expect(f.issue()).rejects.toMatchObject({ status: 503 });
    expect(f.sms.submitPhoneVerification).not.toHaveBeenCalled();
  });
  it("rejects production mock identities and untrusted origins", () => {
    expect(
      fixture({
        NODE_ENV: "production",
        AUTH_PROVIDER: "mock",
      }).service.configuration().enabled,
    ).toBe(false);
    const { service } = fixture({ NODE_ENV: "production" });
    expect(() => service.assertBrowserOrigin()).toThrow();
    expect(() =>
      service.assertBrowserOrigin("https://evil.example.com"),
    ).toThrow();
    expect(() =>
      service.assertBrowserOrigin("https://admin.example.com"),
    ).not.toThrow();
  });
  it("status only exposes a masked existing staff account", async () => {
    const f = fixture();
    expect(await f.service.status(principal)).toEqual({
      configured: true,
      maskedAccount: "138****1234",
      changedAt: NOW.toISOString(),
    });
    await expect(
      f.service.status({ ...principal, authChannel: "WECHAT_MINIAPP" }),
    ).rejects.toMatchObject({ status: 403 });
    f.user.memberships = [
      { organizationId: "org-1", role: "CUSTOMER", status: "ACTIVE" },
    ];
    await expect(f.service.status(principal)).rejects.toMatchObject({
      status: 403,
    });
  });
  it("budgets unknown accounts and hashes rate subjects without creating an identity", async () => {
    const f = fixture();
    f.db.staffPasswordCredential.findUnique.mockResolvedValue(null);
    await expect(f.issue()).rejects.toMatchObject({ status: 401 });
    expect(f.db.browserLoginRateLimit.upsert).toHaveBeenCalledTimes(3);
    expect(verifyStaffPassword).toHaveBeenCalledWith(
      "correct-password",
      expect.stringContaining("scrypt.v1.32768"),
    );
    expect(f.db.user.findUnique).not.toHaveBeenCalled();
    expect(
      JSON.stringify(f.db.browserLoginRateLimit.upsert.mock.calls),
    ).not.toContain("13800001234");
    expect(f.sms.submitPhoneVerification).not.toHaveBeenCalled();
  });
  it("enforces globally committed rate limits before hashing or SMS", async () => {
    const f = fixture();
    f.db.browserLoginRateLimit.upsert.mockResolvedValue({ count: 1_001 });
    await expect(f.issue()).rejects.toMatchObject({ status: 429 });
    expect(f.db.$transaction).not.toHaveBeenCalled();
    expect(f.sms.submitPhoneVerification).not.toHaveBeenCalled();
  });
});

describe("existing staff password management", () => {
  it("requires the actual current session's fresh TOTP, not claimed principal assurance", async () => {
    const f = fixture();
    f.session.mfaVerifiedUntil = null;
    await expect(
      f.service.setPassword(
        { ...principal, mfaVerifiedUntil: new Date(NOW.getTime() + 99_000) },
        "correct-password",
        NOW,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.db.staffPasswordCredential.upsert).not.toHaveBeenCalled();
  });
  it("cannot set a password for unverified phones, customers or miniapp sessions", async () => {
    const f = fixture();
    await expect(
      f.service.setPassword(
        { ...principal, authChannel: "WECHAT_MINIAPP" },
        "correct-password",
        NOW,
      ),
    ).rejects.toMatchObject({ status: 403 });
    f.user.phoneVerifiedAt = null as never;
    await expect(
      f.service.setPassword(principal, "correct-password", NOW),
    ).rejects.toMatchObject({ status: 401 });
    expect(f.db.staffPasswordCredential.upsert).not.toHaveBeenCalled();
  });
  it("version-bumps, invalidates challenges and all trusted devices, preserves only current browser session", async () => {
    const f = fixture();
    await expect(
      f.service.setPassword(principal, "correct-password", NOW),
    ).resolves.toEqual({ configured: true });
    expect(f.db.staffPasswordCredential.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          version: { increment: 1 },
          failedAttempts: 0,
          lockedUntil: null,
        }),
      }),
    );
    expect(f.db.staffTrustedDevice.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", revokedAt: null },
      data: { revokedAt: NOW },
    });
    expect(f.db.session.updateMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        id: { not: "session-1" },
        authChannel: "ADMIN_BROWSER",
        revokedAt: null,
      },
      data: { revokedAt: NOW },
    });
    expect(f.db.session.update).toHaveBeenCalledWith({
      where: { id: "session-1" },
      data: { staffPasswordVersion: 2, trustedDeviceId: null },
    });
    expect(JSON.stringify(f.db.auditLog.create.mock.calls)).not.toContain(
      "correct-password",
    );
    expect(JSON.stringify(f.db.auditLog.create.mock.calls)).not.toContain(
      "13800001234",
    );
  });
  it("password changes never prolong existing TOTP or remembered-device assurance", async () => {
    const f = fixture();
    await f.service.setPassword(principal, "correct-password", NOW);
    const update = f.db.session.update.mock.calls[0][0].data;
    expect(update.trustedDeviceId).toBeNull();
    expect(update).not.toHaveProperty("staffVerifiedUntil");
    expect(update).not.toHaveProperty("staffVerificationMethod");
    expect(update).not.toHaveProperty("mfaVerifiedUntil");
    expect(update).not.toHaveProperty("authProvider");
    expect(f.session.mfaVerifiedUntil?.getTime()).toBe(NOW.getTime() + 60_000);
    expect(f.db.staffTrustedDevice.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", revokedAt: null },
      data: { revokedAt: NOW },
    });
  });
});

describe("password then bound-phone SMS challenge", () => {
  it("only sends to the server-decrypted verified phone and stores proof hashes", async () => {
    const f = fixture();
    const challenge = await f.issue();
    expect(f.sms.submitPhoneVerification).toHaveBeenCalledWith({
      phone: "13800001234",
      code: expect.stringMatching(/^\d{6}$/),
      trackingId: challenge.challengeId,
    });
    const row = f.rows.get(challenge.challengeId);
    expect(row.secretHash).toBe(
      f.crypto.hashBrowserLogin(
        "staff-password:secret",
        challenge.challengeSecret,
      ),
    );
    expect(row.codeHash).toBe(
      f.crypto.hashBrowserLogin(
        "staff-password:code",
        `${challenge.challengeId}:${challenge.code}`,
      ),
    );
    expect(row.status).toBe("ACCEPTED");
    expect(Date.parse(challenge.expiresAt) - NOW.getTime()).toBe(300_000);
    expect(
      JSON.stringify(f.db.staffPasswordLoginChallenge.create.mock.calls),
    ).not.toContain(challenge.challengeSecret);
    expect(
      JSON.stringify(f.db.staffPasswordLoginChallenge.create.mock.calls),
    ).not.toContain(challenge.code);
    expect(JSON.stringify(challenge)).not.toContain("13800001234");
  });
  it("commits five bad-password failures then locks for 15 minutes", async () => {
    const f = fixture();
    for (let i = 0; i < 5; i++)
      await expect(
        f.service.login(
          { account: "13800001234", password: "wrong-password" },
          "peer",
          NOW,
        ),
      ).rejects.toMatchObject({ status: 401 });
    expect(f.credential.failedAttempts).toBe(5);
    expect(f.credential.lockedUntil?.getTime()).toBe(NOW.getTime() + 900_000);
    await expect(f.issue()).rejects.toMatchObject({ status: 401 });
    expect(f.sms.submitPhoneVerification).not.toHaveBeenCalled();
  });
  it("clears stale lock failure count when correct credentials are retried after expiry", async () => {
    const f = fixture();
    f.credential.failedAttempts = 5;
    f.credential.lockedUntil = new Date(NOW.getTime() - 1);
    await f.issue();
    expect(f.credential.failedAttempts).toBe(0);
    expect(f.credential.lockedUntil).toBeNull();
  });
  it.each(["customer", "suspended", "unverified", "phone-changed"])(
    "does not send SMS for %s identity",
    async (kind) => {
      const f = fixture();
      if (kind === "customer")
        f.user.memberships = [
          { role: "CUSTOMER", status: "ACTIVE", organizationId: "org-1" },
        ];
      if (kind === "suspended") f.user.status = "SUSPENDED";
      if (kind === "unverified") f.user.phoneVerifiedAt = null as never;
      if (kind === "phone-changed")
        f.user.phoneEncrypted = f.crypto.encrypt("13900001234");
      await expect(f.issue()).rejects.toMatchObject({ status: 401 });
      expect(f.sms.submitPhoneVerification).not.toHaveBeenCalled();
    },
  );
  it("cooldown and SMS hourly budget prevent repeated provider calls", async () => {
    const f = fixture();
    f.db.staffPasswordLoginChallenge.findFirst.mockResolvedValue({
      id: "recent-challenge",
    });
    await expect(f.issue()).rejects.toMatchObject({ status: 429 });
    expect(f.sms.submitPhoneVerification).not.toHaveBeenCalled();
  });
  it("rejects provider failures and does not reopen invalidated in-flight challenges", async () => {
    const f = fixture();
    f.sms.submitPhoneVerification.mockResolvedValue({
      status: "REJECTED",
    } as never);
    await expect(f.issue()).rejects.toMatchObject({ status: 503 });
    expect([...f.rows.values()][0].status).toBe("REJECTED");
    const g = fixture();
    g.sms.submitPhoneVerification.mockImplementation(async () => {
      [...g.rows.values()][0].status = "REJECTED";
      return { status: "ACCEPTED", requestId: "r", bizId: "b" };
    });
    await expect(g.issue()).rejects.toMatchObject({ status: 401 });
    expect([...g.rows.values()][0].status).toBe("REJECTED");
  });
});

describe("single-use staff SMS confirmation", () => {
  it("racing confirmations still issue only one session", async () => {
    const f = fixture(),
      input = await f.issue();
    const results = await Promise.allSettled([
      f.service.confirm(input, "peer", NOW),
      f.service.confirm(input, "peer", NOW),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(f.db.session.create).toHaveBeenCalledTimes(1);
  });
  it("consumes a challenge exactly once and never claims fresh TOTP assurance", async () => {
    const f = fixture(),
      input = await f.issue();
    const result = await f.service.confirm(input, "socket-peer", NOW);
    expect(AuthSessionSchema.parse(result).user.phoneVerified).toBe(true);
    expect(result.user.memberships).toEqual([
      { organizationId: "org-1", role: "OPERATOR" },
    ]);
    expect(f.db.session.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        authChannel: "ADMIN_BROWSER",
        authProvider: "staff-password",
        mfaVerifiedUntil: null,
        staffVerifiedUntil: expect.any(Date),
        staffVerificationMethod: "PASSWORD_SMS",
        staffPasswordVersion: 1,
      }),
    });
    await expect(
      f.service.confirm(input, "socket-peer", NOW),
    ).rejects.toMatchObject({ status: 401 });
    expect(f.db.session.create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.db.auditLog.create.mock.calls)).not.toContain(
      input.challengeSecret,
    );
    expect(JSON.stringify(f.db.auditLog.create.mock.calls)).not.toContain(
      input.code,
    );
  });
  it.each(["PENDING", "REJECTED"])(
    "cannot confirm %s provider delivery state",
    async (status) => {
      const f = fixture(),
        input = await f.issue();
      f.rows.get(input.challengeId).status = status;
      await expect(f.service.confirm(input, "peer", NOW)).rejects.toMatchObject(
        { status: 401 },
      );
      expect(f.db.session.create).not.toHaveBeenCalled();
    },
  );
  it("can confirm UNKNOWN acceptance only with both generated proofs", async () => {
    const f = fixture();
    f.sms.submitPhoneVerification.mockResolvedValue({
      status: "UNKNOWN",
    } as never);
    const input = await f.issue();
    await expect(f.service.confirm(input, "peer", NOW)).resolves.toHaveProperty(
      "accessToken",
    );
  });
  it("commits wrong secret and wrong code attempts, closes the challenge on fifth failure", async () => {
    const f = fixture(),
      input = await f.issue();
    for (let i = 0; i < 5; i++)
      await expect(
        f.service.confirm({ ...input, code: "000000" }, "peer", NOW),
      ).rejects.toMatchObject({ status: 401 });
    const row = f.rows.get(input.challengeId);
    expect(row.attempts).toBe(5);
    expect(row.status).toBe("REJECTED");
    expect(row.consumedAt).toBe(NOW);
    await expect(f.service.confirm(input, "peer", NOW)).rejects.toMatchObject({
      status: 401,
    });
    expect(f.db.session.create).not.toHaveBeenCalled();
  });
  it.each([
    "password-changed",
    "phone-changed",
    "role-revoked",
    "user-suspended",
    "locked",
  ])("rechecks %s before issuing a session", async (kind) => {
    const f = fixture(),
      input = await f.issue();
    if (kind === "password-changed") f.credential.version++;
    if (kind === "phone-changed")
      f.user.phoneEncrypted = f.crypto.encrypt("13900001234");
    if (kind === "role-revoked") f.user.memberships = [];
    if (kind === "user-suspended") f.user.status = "SUSPENDED";
    if (kind === "locked")
      f.credential.lockedUntil = new Date(NOW.getTime() + 10_000);
    await expect(f.service.confirm(input, "peer", NOW)).rejects.toMatchObject({
      status: 401,
    });
    expect(f.rows.get(input.challengeId).status).toBe("REJECTED");
    expect(f.db.session.create).not.toHaveBeenCalled();
  });
  it("expires after five minutes and cannot accept another browser's secret", async () => {
    const f = fixture(),
      input = await f.issue();
    await expect(
      f.service.confirm(
        { ...input, challengeSecret: "different-browser-secret" },
        "peer",
        NOW,
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(f.rows.get(input.challengeId).attempts).toBe(1);
    await expect(
      f.service.confirm(input, "peer", new Date(NOW.getTime() + 300_000)),
    ).rejects.toMatchObject({ status: 401 });
    expect(f.db.session.create).not.toHaveBeenCalled();
  });
});
