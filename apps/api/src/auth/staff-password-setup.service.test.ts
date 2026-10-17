import { describe, expect, it, vi } from "vitest";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { AuthSessionSchema } from "@zydj/contracts";
import { AuthCryptoService } from "./auth-crypto.service.js";
import { StaffPasswordSetupService } from "./staff-password-setup.service.js";
import {
  hashStaffPassword,
  PasswordHashCapacityError,
} from "./password-hash.js";

vi.mock("./password-hash.js", async (importActual) => ({
  ...(await importActual<typeof import("./password-hash.js")>()),
  hashStaffPassword: vi.fn(async () => "scrypt-test-hash"),
}));

const NOW = new Date("2026-10-17T12:00:00Z");
const PHONE = "13800001234";
const PASSWORD = "a-long-self-set-password";
function fixture() {
  const crypto = new AuthCryptoService(
    new ConfigService({
      AUTH_SESSION_PEPPER: "test-pepper-of-at-least-thirty-two-chars",
      DATA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 1).toString("base64"),
    }) as never,
  );
  const phoneHash = crypto.hashPhoneVerification("phone", PHONE);
  const state: any = {
    user: {
      id: "staff-1",
      displayName: "staff",
      status: "ACTIVE",
      phoneVerifiedAt: NOW,
      phoneEncrypted: crypto.encrypt(PHONE),
      memberships: [
        { organizationId: "org-1", role: "OPERATOR", status: "ACTIVE" },
      ],
    },
    binding: { userId: "staff-1", phoneHash },
    credential: null,
    mfa: null,
    challenges: new Map<string, any>(),
  };
  const db: any = {
    $queryRaw: vi.fn(async () => []),
    $executeRaw: vi.fn(async () => 1),
    browserLoginRateLimit: { upsert: vi.fn(async () => ({ count: 1 })) },
    customerPhoneIdentity: {
      findUnique: vi.fn(async ({ where }: any) =>
        state.binding?.phoneHash === where.phoneHash ? state.binding : null,
      ),
    },
    user: { findUnique: vi.fn(async () => state.user) },
    mfaCredential: { findUnique: vi.fn(async () => state.mfa) },
    staffPasswordCredential: {
      findUnique: vi.fn(async () => state.credential),
      create: vi.fn(async ({ data }: any) => {
        if (state.credential)
          throw new Prisma.PrismaClientKnownRequestError("private conflict", {
            code: "P2002",
            clientVersion: "test",
          });
        state.credential = { ...data };
        return state.credential;
      }),
    },
    staffPasswordSetupChallenge: {
      findUnique: vi.fn(
        async ({ where }: any) => state.challenges.get(where.id) ?? null,
      ),
      findFirst: vi.fn(
        async ({ where }: any) =>
          [...state.challenges.values()].find(
            (row: any) =>
              row.userId === where.userId && row.createdAt > where.createdAt.gt,
          ) ?? null,
      ),
      create: vi.fn(async ({ data }: any) => {
        const row = { ...data, attempts: 0, consumedAt: null };
        state.challenges.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = state.challenges.get(where.id);
        Object.assign(row, data);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const row of state.challenges.values()) {
          if (typeof where.id === "string" && row.id !== where.id) continue;
          if (where.id?.not && row.id === where.id.not) continue;
          if (where.userId && row.userId !== where.userId) continue;
          if (where.consumedAt === null && row.consumedAt !== null) continue;
          if (typeof where.status === "string" && row.status !== where.status)
            continue;
          if (where.status?.in && !where.status.in.includes(row.status))
            continue;
          if (where.expiresAt && row.expiresAt <= where.expiresAt.gt) continue;
          if (where.attempts && row.attempts >= where.attempts.lt) continue;
          Object.assign(row, data);
          count++;
        }
        return { count };
      }),
    },
    session: { create: vi.fn(async () => ({ id: "session-1" })) },
    auditLog: { create: vi.fn(async () => ({})) },
  };
  // Serialize fixture transactions and roll back state like the PostgreSQL
  // transaction. The SQL assertions below independently verify real row locks.
  let tail = Promise.resolve();
  db.$transaction = vi.fn((callback: any) => {
    const operation = tail.then(async () => {
      const before = structuredClone(state);
      try {
        return await callback(db);
      } catch (error) {
        Object.assign(state, before);
        throw error;
      }
    });
    tail = operation.catch(() => undefined);
    return operation;
  });
  const sms = {
    submitPhoneVerification: vi.fn(async () => ({
      status: "ACCEPTED",
      requestId: "provider-request",
      bizId: "provider-biz",
    })),
  };
  const passwords = {
    configuration: vi.fn(() => ({
      enabled: true,
      smsEnabled: true,
      setupEnabled: true,
    })),
    assertBrowserOrigin: vi.fn(),
  };
  const service = new StaffPasswordSetupService(
    db,
    crypto,
    sms as never,
    passwords as never,
  );
  const request = (now = NOW) => service.request({ phone: PHONE }, "peer", now);
  async function issue(now = NOW) {
    const response = await request(now);
    const sent = sms.submitPhoneVerification.mock.calls.at(-1) as unknown as [
      { code: string },
    ];
    return {
      ...response,
      code: sent[0].code,
      loginAlias: "admin",
      password: PASSWORD,
    };
  }
  return {
    service,
    db,
    crypto,
    sms,
    passwords,
    state,
    phoneHash,
    request,
    issue,
  };
}

describe("first-time staff password setup request", () => {
  it("fails closed before lookup or provider I/O when setup is not enabled", async () => {
    const f = fixture();
    f.passwords.configuration.mockReturnValue({
      enabled: true,
      smsEnabled: true,
      setupEnabled: false,
    });
    await expect(f.request()).rejects.toMatchObject({ status: 503 });
    expect(f.db.customerPhoneIdentity.findUnique).not.toHaveBeenCalled();
    expect(f.sms.submitPhoneVerification).not.toHaveBeenCalled();
  });
  it("stores dedicated HMAC proofs and only sends to the existing server-verified phone", async () => {
    const f = fixture(),
      input = await f.issue();
    expect(input).toMatchObject({
      challengeId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      challengeSecret: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      maskedPhone: "138****1234",
      expiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
      retryAfterSeconds: 60,
    });
    expect(f.sms.submitPhoneVerification).toHaveBeenCalledExactlyOnceWith({
      phone: PHONE,
      code: input.code,
      trackingId: input.challengeId,
    });
    const row = f.state.challenges.get(input.challengeId);
    expect(row.secretHash).toBe(
      f.crypto.hashBrowserLogin(
        "staff-password-setup:secret",
        input.challengeSecret,
      ),
    );
    expect(row.codeHash).toBe(
      f.crypto.hashBrowserLogin(
        "staff-password-setup:code",
        `${input.challengeId}:${input.code}`,
      ),
    );
    expect(row.secretHash).not.toBe(
      f.crypto.hashBrowserLogin("staff-password:secret", input.challengeSecret),
    );
    expect(row.status).toBe("ACCEPTED");
    for (const calls of [
      f.db.staffPasswordSetupChallenge.create.mock.calls,
      f.db.auditLog.create.mock.calls,
    ]) {
      const stored = JSON.stringify(calls);
      for (const secret of [PHONE, PASSWORD, input.challengeSecret, input.code])
        expect(stored).not.toContain(secret);
    }
    expect(f.db.staffPasswordCredential.create).not.toHaveBeenCalled();
    expect(f.db.session.create).not.toHaveBeenCalled();
  });
  it.each([
    "unknown",
    "ordinary-customer",
    "therapist-only",
    "inactive-role",
    "suspended",
    "unverified",
    "undecryptable",
    "phone-drift",
    "existing-password",
    "enabled-mfa",
    "pending-mfa",
  ])(
    "returns a neutral opaque receipt without sending for %s",
    async (kind) => {
      const f = fixture();
      if (kind === "unknown") f.state.binding = null;
      if (kind === "ordinary-customer")
        f.state.user.memberships[0].role = "CUSTOMER";
      if (kind === "therapist-only")
        f.state.user.memberships[0].role = "THERAPIST";
      if (kind === "inactive-role")
        f.state.user.memberships[0].status = "SUSPENDED";
      if (kind === "suspended") f.state.user.status = "SUSPENDED";
      if (kind === "unverified") f.state.user.phoneVerifiedAt = null;
      if (kind === "undecryptable") f.state.user.phoneEncrypted = "broken";
      if (kind === "phone-drift")
        f.state.user.phoneEncrypted = f.crypto.encrypt("13900001234");
      if (kind === "existing-password")
        f.state.credential = { userId: "staff-1", version: 8 };
      if (kind === "enabled-mfa")
        f.state.mfa = { enabledAt: NOW, enrollmentExpiresAt: null };
      if (kind === "pending-mfa")
        f.state.mfa = {
          enabledAt: null,
          enrollmentExpiresAt: new Date(NOW.getTime() + 1),
        };
      const receipt = await f.request();
      expect(Object.keys(receipt).sort()).toEqual(
        [
          "challengeId",
          "challengeSecret",
          "maskedPhone",
          "expiresAt",
          "retryAfterSeconds",
        ].sort(),
      );
      expect(receipt.maskedPhone).toBe("138****1234");
      expect(f.state.challenges.size).toBe(0);
      expect(f.sms.submitPhoneVerification).not.toHaveBeenCalled();
      expect(f.db.staffPasswordCredential.create).not.toHaveBeenCalled();
      await expect(
        f.service.confirm(
          {
            ...receipt,
            code: "123456",
            loginAlias: "admin",
            password: PASSWORD,
          },
          "peer",
          NOW,
        ),
      ).rejects.toMatchObject({ status: 401 });
    },
  );
  it.each([
    "OPERATOR",
    "DISPATCHER",
    "FINANCE_REQUESTER",
    "FINANCE_APPROVER",
    "SAFETY_DUTY",
    "ADMIN",
  ])(
    "allows only the existing active %s account without adding permissions",
    async (role) => {
      const f = fixture();
      f.state.user.memberships[0].role = role;
      await f.request();
      expect(f.sms.submitPhoneVerification).toHaveBeenCalledTimes(1);
      expect(f.state.user.memberships).toEqual([
        { role, status: "ACTIVE", organizationId: "org-1" },
      ]);
    },
  );
  it("allows expired unactivated enrollment without modifying its secret", async () => {
    const f = fixture();
    f.state.mfa = {
      enabledAt: null,
      enrollmentExpiresAt: NOW,
      secretEncrypted: "unchanged",
    };
    await f.issue();
    expect(f.sms.submitPhoneVerification).toHaveBeenCalledTimes(1);
    expect(f.state.mfa.secretEncrypted).toBe("unchanged");
  });
  it("uses committed global/IP/phone limits and shares normal staff SMS account budgets", async () => {
    const f = fixture();
    await f.request();
    for (const [purpose, window] of [
      ["sms-account-hour", 3_600_000],
      ["sms-account-day", 86_400_000],
      ["account-login", 600_000],
    ] as const) {
      const key = f.crypto.hashBrowserLogin(
        `staff-password:rate:${purpose}`,
        `${f.phoneHash}:${Math.floor(NOW.getTime() / window)}`,
      );
      expect(f.db.browserLoginRateLimit.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { key } }),
      );
    }
    expect(
      JSON.stringify(f.db.browserLoginRateLimit.upsert.mock.calls),
    ).not.toContain(PHONE);
    const g = fixture();
    g.db.browserLoginRateLimit.upsert.mockResolvedValue({ count: 301 });
    await expect(g.request()).rejects.toMatchObject({ status: 429 });
    expect(g.db.$transaction).not.toHaveBeenCalled();
    expect(g.sms.submitPhoneVerification).not.toHaveBeenCalled();
  });
  it("cooldown and replacement never send automatically or leave old codes active", async () => {
    const f = fixture(),
      first = await f.issue();
    const neutral = await f.request(new Date(NOW.getTime() + 59_999));
    expect(f.state.challenges.has(neutral.challengeId)).toBe(false);
    expect(f.sms.submitPhoneVerification).toHaveBeenCalledTimes(1);
    await f.issue(new Date(NOW.getTime() + 60_000));
    expect(f.sms.submitPhoneVerification).toHaveBeenCalledTimes(2);
    expect(f.state.challenges.get(first.challengeId)).toMatchObject({
      status: "REJECTED",
      consumedAt: new Date(NOW.getTime() + 60_000),
    });
  });
  it.each(["REJECTED", "THROW", "BUDGET_429"])(
    "keeps %s provider/budget failures neutral, audited, unconfirmable and single-send",
    async (outcome) => {
      const f = fixture();
      if (outcome === "REJECTED")
        f.sms.submitPhoneVerification.mockResolvedValue({
          status: "REJECTED",
        } as never);
      else
        f.sms.submitPhoneVerification.mockRejectedValue(
          outcome === "BUDGET_429"
            ? Object.assign(new Error("do not reflect provider data"), {
                status: 429,
              })
            : new Error("private provider failure"),
        );
      const receipt = await f.request();
      expect(receipt).toHaveProperty("challengeSecret");
      expect(f.sms.submitPhoneVerification).toHaveBeenCalledTimes(1);
      expect(f.state.challenges.get(receipt.challengeId).status).toBe(
        "REJECTED",
      );
      const sent = f.sms.submitPhoneVerification.mock.calls[0] as unknown as [
        { code: string },
      ];
      await expect(
        f.service.confirm(
          {
            ...receipt,
            code: sent[0].code,
            password: PASSWORD,
            loginAlias: "admin",
          },
          "peer",
          NOW,
        ),
      ).rejects.toMatchObject({ status: 401 });
      const audits = JSON.stringify(f.db.auditLog.create.mock.calls);
      expect(audits).toContain("AUTH_STAFF_PASSWORD_SETUP_SMS_RESULT");
      expect(audits).not.toContain("private provider");
      expect(audits).not.toContain(PHONE);
      expect(audits).not.toContain(sent[0].code);
    },
  );
  it("never resurrects an in-flight challenge cancelled while the provider is responding", async () => {
    const f = fixture();
    f.sms.submitPhoneVerification.mockImplementation(async () => {
      Object.assign([...f.state.challenges.values()][0] as object, {
        status: "REJECTED",
        consumedAt: NOW,
      });
      return { status: "ACCEPTED", requestId: "r", bizId: "b" };
    });
    const input = await f.issue();
    expect(f.state.challenges.get(input.challengeId).status).toBe("REJECTED");
    await expect(f.service.confirm(input, "peer", NOW)).rejects.toMatchObject({
      status: 401,
    });
  });
});

describe("one-time staff setup confirmation", () => {
  it("creates only a credential v1 and a normal SMS-verified browser session, never fresh TOTP", async () => {
    const f = fixture(),
      input = await f.issue();
    const result = await f.service.confirm(
      { ...input, loginAlias: " AdMiN " },
      "peer",
      NOW,
    );
    expect(AuthSessionSchema.parse(result).user.memberships).toEqual([
      { organizationId: "org-1", role: "OPERATOR" },
    ]);
    expect(f.state.credential).toEqual({
      userId: "staff-1",
      phoneHash: f.phoneHash,
      loginAlias: "admin",
      passwordHash: "scrypt-test-hash",
      version: 1,
    });
    expect(f.db.session.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        authChannel: "ADMIN_BROWSER",
        authProvider: "staff-password",
        mfaVerifiedUntil: null,
        staffVerificationMethod: "PASSWORD_SMS",
        staffVerifiedUntil: new Date(NOW.getTime() + 3_600_000),
        staffPasswordVersion: 1,
      }),
    });
    expect(f.state.mfa).toBeNull();
    const sql = f.db.$queryRaw.mock.calls
      .map(([parts]: any[]) => parts.join("?"))
      .join("\n");
    expect(sql).toContain('FROM "User" WHERE "id" = ? FOR NO KEY UPDATE');
    expect(sql).toContain(
      'FROM "StaffPasswordSetupChallenge" WHERE "id" = ? FOR UPDATE',
    );
    const audits = JSON.stringify(f.db.auditLog.create.mock.calls);
    for (const secret of [
      PASSWORD,
      input.code,
      input.challengeSecret,
      result.accessToken,
      PHONE,
      "admin",
    ])
      expect(audits).not.toContain(secret);
    await expect(f.service.confirm(input, "peer", NOW)).rejects.toMatchObject({
      status: 401,
    });
    expect(f.db.session.create).toHaveBeenCalledTimes(1);
  });
  it("serializes racing confirmations into exactly one credential and session", async () => {
    const f = fixture(),
      input = await f.issue();
    const results = await Promise.allSettled([
      f.service.confirm(input, "peer", NOW),
      f.service.confirm(input, "peer", NOW),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(f.db.staffPasswordCredential.create).toHaveBeenCalledTimes(1);
    expect(f.db.session.create).toHaveBeenCalledTimes(1);
  });
  it("accepts UNKNOWN only when both correct setup proofs are supplied", async () => {
    const f = fixture();
    f.sms.submitPhoneVerification.mockResolvedValue({
      status: "UNKNOWN",
    } as never);
    const input = await f.issue();
    await expect(f.service.confirm(input, "peer", NOW)).resolves.toHaveProperty(
      "accessToken",
    );
    expect(f.sms.submitPhoneVerification).toHaveBeenCalledTimes(1);
  });
  it.each(["PENDING", "REJECTED", "CONSUMED"])(
    "rejects %s states",
    async (status) => {
      const f = fixture(),
        input = await f.issue();
      f.state.challenges.get(input.challengeId).status = status;
      await expect(f.service.confirm(input, "peer", NOW)).rejects.toMatchObject(
        { status: 401 },
      );
      expect(f.db.staffPasswordCredential.create).not.toHaveBeenCalled();
    },
  );
  it.each(["wrong-code", "wrong-secret"])(
    "commits five %s failures before rejecting all further attempts",
    async (kind) => {
      const f = fixture(),
        input = await f.issue();
      for (let index = 0; index < 5; index++) {
        await expect(
          f.service.confirm(
            {
              ...input,
              ...(kind === "wrong-code"
                ? { code: "000000" }
                : { challengeSecret: "B".repeat(43) }),
            },
            "peer",
            NOW,
          ),
        ).rejects.toMatchObject({ status: 401 });
      }
      expect(f.state.challenges.get(input.challengeId)).toMatchObject({
        attempts: 5,
        status: "REJECTED",
        consumedAt: NOW,
      });
      await expect(f.service.confirm(input, "peer", NOW)).rejects.toMatchObject(
        { status: 401 },
      );
      expect(f.db.session.create).not.toHaveBeenCalled();
    },
  );
  it.each(["expired", "future"])(
    "rejects a %s challenge without creating a credential",
    async (kind) => {
      const f = fixture(),
        input = await f.issue();
      const row = f.state.challenges.get(input.challengeId);
      if (kind === "future") row.createdAt = new Date(NOW.getTime() + 1);
      const time = kind === "expired" ? new Date(NOW.getTime() + 300_000) : NOW;
      await expect(
        f.service.confirm(input, "peer", time),
      ).rejects.toMatchObject({ status: 401 });
      expect(f.db.staffPasswordCredential.create).not.toHaveBeenCalled();
    },
  );
  it.each([
    "credential-created",
    "mfa-enabled",
    "mfa-pending",
    "phone-changed",
    "binding-changed",
    "binding-removed",
    "role-removed",
    "role-suspended",
    "customer-only",
    "therapist-only",
    "user-disabled",
    "phone-unverified",
  ])(
    "rechecks %s under the User lock and cannot reset or bypass it",
    async (kind) => {
      const f = fixture(),
        input = await f.issue();
      if (kind === "credential-created")
        f.state.credential = { version: 9, passwordHash: "keep-existing" };
      if (kind === "mfa-enabled") f.state.mfa = { enabledAt: NOW };
      if (kind === "mfa-pending")
        f.state.mfa = { enrollmentExpiresAt: new Date(NOW.getTime() + 1) };
      if (kind === "phone-changed")
        f.state.user.phoneEncrypted = f.crypto.encrypt("13900001234");
      if (kind === "binding-changed") f.state.binding.userId = "other-user";
      if (kind === "binding-removed") f.state.binding = null;
      if (kind === "role-removed") f.state.user.memberships = [];
      if (kind === "role-suspended")
        f.state.user.memberships[0].status = "SUSPENDED";
      if (kind === "customer-only")
        f.state.user.memberships[0].role = "CUSTOMER";
      if (kind === "therapist-only")
        f.state.user.memberships[0].role = "THERAPIST";
      if (kind === "user-disabled") f.state.user.status = "SUSPENDED";
      if (kind === "phone-unverified") f.state.user.phoneVerifiedAt = null;
      await expect(f.service.confirm(input, "peer", NOW)).rejects.toMatchObject(
        { status: 401 },
      );
      expect(f.state.challenges.get(input.challengeId).status).toBe("REJECTED");
      expect(f.db.staffPasswordCredential.create).not.toHaveBeenCalled();
      expect(f.db.session.create).not.toHaveBeenCalled();
      if (kind === "credential-created")
        expect(f.state.credential.passwordHash).toBe("keep-existing");
    },
  );
  it("maps a database uniqueness race to a generic conflict and rolls back consumption", async () => {
    const f = fixture(),
      input = await f.issue();
    f.db.staffPasswordCredential.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("private owner or alias", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: ["loginAlias"] },
      }),
    );
    await expect(f.service.confirm(input, "peer", NOW)).rejects.toMatchObject({
      status: 409,
      message: "登录名不可用",
    });
    expect(f.state.challenges.get(input.challengeId).consumedAt).toBeNull();
    expect(f.state.credential).toBeNull();
    expect(f.db.session.create).not.toHaveBeenCalled();
    await expect(
      f.service.confirm({ ...input, loginAlias: "another-name" }, "peer", NOW),
    ).resolves.toHaveProperty("accessToken");
  });
  it("rolls back challenge consumption when bounded password hashing is busy", async () => {
    const f = fixture(),
      input = await f.issue();
    vi.mocked(hashStaffPassword).mockRejectedValueOnce(
      new PasswordHashCapacityError(),
    );
    await expect(f.service.confirm(input, "peer", NOW)).rejects.toMatchObject({
      status: 429,
    });
    expect(f.state.challenges.get(input.challengeId).consumedAt).toBeNull();
    expect(f.db.staffPasswordCredential.create).not.toHaveBeenCalled();
  });
});
