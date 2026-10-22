import { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";
import { AuthCryptoService } from "./auth-crypto.service.js";
import { AuthService } from "./auth.service.js";
import { TechnicianPhoneAuthService } from "./technician-phone-auth.service.js";
import { TechnicianPhoneAuthController } from "./technician-phone-auth.controller.js";
import {
  customerSmsRouteAllowed,
  SessionAuthGuard,
  technicianPhoneRouteAllowed,
} from "./session-auth.guard.js";
import {
  TechnicianPhoneProfileDraftSchema,
  TechnicianPhoneSmsConfirmSchema,
  TechnicianPhoneSmsRequestResultSchema,
} from "@zydj/contracts";

const phone = "13800138000",
  ip = "127.0.0.1";
function fixture(overrides = {}) {
  const settings: Record<string, any> = {
    NODE_ENV: "test",
    TECHNICIAN_PHONE_LOGIN_ENABLED: "true",
    TECHNICIAN_PHONE_WORKBENCH_ENABLED: "false",
    SMS_PROVIDER: "aliyun",
    SMS_SEND_ENABLED: "true",
    PHONE_VERIFICATION_SMS_ENABLED: "true",
    PHONE_VERIFICATION_SMS_DAILY_REQUEST_LIMIT: 20,
    ALIYUN_SMS_ACCESS_KEY_ID: "fixture",
    ALIYUN_SMS_ACCESS_KEY_SECRET: "fixture-not-real",
    ALIYUN_SMS_SIGN_NAME: "测试",
    ALIYUN_SMS_PHONE_VERIFICATION_TEMPLATE_CODE: "SMS_FIXTURE",
    AUTH_SESSION_TTL_SECONDS: 604800,
    AUTH_SESSION_PEPPER: "fixture-technician-pepper-not-production",
    DATA_ENCRYPTION_KEY_BASE64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    ...overrides,
  };
  const config = new ConfigService(settings),
    crypto = new AuthCryptoService(config as never);
  const phones = {
    hash: (value: string) => crypto.hashPhoneVerification("phone", value),
    lock: vi.fn(),
    findOwner: vi.fn().mockResolvedValue("user"),
    register: vi.fn(),
  };
  const user: any = {
    id: "user",
    status: "ACTIVE",
    displayName: "Fixture",
    phoneEncrypted: crypto.encrypt(phone),
    phoneVerifiedAt: new Date(),
    memberships: [
      { organizationId: "org", role: "ADMIN" },
      { organizationId: "org", role: "THERAPIST" },
      { organizationId: "other", role: "THERAPIST" },
    ],
    technicianProfile: { organizationId: "org", status: "APPROVED" },
  };
  const proofs = new Map<string, any>();
  const challenge = {
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn(async (input) => proofs.get(input.where.id) ?? null),
    create: vi.fn(async ({ data }) => {
      const row = {
        ...data,
        attempts: 0,
        consumedAt: null,
        status: "PENDING",
        createdAt: new Date(),
      };
      proofs.set(data.id, row);
      return row;
    }),
    update: vi.fn(async ({ where, data }) => {
      const row = proofs.get(where.id);
      if (row)
        Object.assign(row, {
          ...data,
          ...(data.attempts
            ? { attempts: row.attempts + data.attempts.increment }
            : {}),
        });
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }) => {
      const rows = [...proofs.values()].filter(
        (row) =>
          (where.id
            ? row.id === where.id
            : row.phoneHash === where.phoneHash) &&
          !row.consumedAt &&
          (!where.status?.in || where.status.in.includes(row.status)) &&
          (!where.status ||
            typeof where.status !== "string" ||
            row.status === where.status),
      );
      rows.forEach((row) => Object.assign(row, data));
      return { count: rows.length };
    }),
  };
  const tx = {
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
    technicianPhoneLoginChallenge: challenge,
    user: {
      findUnique: vi.fn(async () => user),
      create: vi.fn().mockResolvedValue({ id: "user" }),
    },
    session: { create: vi.fn() },
    auditLog: { create: vi.fn() },
    phoneVerificationRateLimit: {
      upsert: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const prisma: any = {
    ...tx,
    $transaction: vi.fn(async (operation) => operation(tx)),
    customerPhoneIdentity: {
      findUnique: vi.fn(async () => ({ phoneHash: phones.hash(phone) })),
    },
    technicianProfile: {
      findUnique: vi.fn(async () => user.technicianProfile),
    },
  };
  const sms = {
    submitPhoneVerification: vi
      .fn()
      .mockResolvedValue({
        status: "ACCEPTED",
        requestId: "fixture-request",
        bizId: "fixture-biz",
      }),
  };
  const service = new TechnicianPhoneAuthService(
    prisma,
    crypto,
    config as never,
    phones as never,
    sms as never,
  );
  async function request() {
    return service.requestSms({ phone, agreementsAccepted: true }, ip);
  }
  async function confirm(
    receipt: Awaited<ReturnType<typeof request>>,
    extra = {},
  ) {
    const code = sms.submitPhoneVerification.mock.calls[0]![0].code;
    return service.confirmSms(
      { phone, code, ...receipt, agreementsAccepted: true, ...extra },
      ip,
    );
  }
  return {
    service,
    prisma,
    tx,
    phones,
    sms,
    user,
    crypto,
    config,
    settings,
    proofs,
    request,
    confirm,
  };
}

describe("technician phone purpose-isolated authentication", () => {
  it.each([
    { TECHNICIAN_PHONE_LOGIN_ENABLED: "false" },
    { PHONE_VERIFICATION_SMS_ENABLED: "false" },
    { SMS_SEND_ENABLED: "false" },
    { SMS_PROVIDER: "mock" },
    { ALIYUN_SMS_ACCESS_KEY_SECRET: "" },
    { PHONE_VERIFICATION_SMS_DAILY_REQUEST_LIMIT: 0 },
  ])("fails closed before proof creation or SMS: %j", async (fields) => {
    const f = fixture(fields);
    expect(f.service.capabilities()).toEqual({
      enabled: false,
      workbenchEnabled: false,
    });
    await expect(f.request()).rejects.toThrow("尚未开放");
    expect(f.sms.submitPhoneVerification).not.toHaveBeenCalled();
    expect(f.tx.technicianPhoneLoginChallenge.create).not.toHaveBeenCalled();
  });
  it("requires explicit technician agreement even with direct service calls", async () => {
    const f = fixture();
    await expect(
      f.service.requestSms({ phone, agreementsAccepted: false } as never, ip),
    ).rejects.toThrow("技师入驻协议");
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
  it("returns opaque proof; persists only encrypted phone and keyed code/secret; never creates user on request", async () => {
    const f = fixture(),
      receipt = await f.request();
    expect(
      TechnicianPhoneSmsRequestResultSchema.safeParse(receipt).success,
    ).toBe(true);
    const row = f.proofs.get(receipt.challengeId);
    expect(row.secretHash).not.toBe(receipt.challengeSecret);
    expect(row.phoneEncrypted).not.toBe(phone);
    expect(
      row.expiresAt.getTime() - row.createdAt.getTime(),
    ).toBeLessThanOrEqual(300000);
    expect(f.tx.user.create).not.toHaveBeenCalled();
    expect(f.phones.findOwner).not.toHaveBeenCalled();
    expect(JSON.stringify(f.tx.auditLog.create.mock.calls)).not.toContain(
      phone,
    );
    expect(JSON.stringify(f.tx.auditLog.create.mock.calls)).not.toContain(
      receipt.challengeSecret,
    );
    expect(f.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 15000,
      maxWait: 5000,
    });
  });
  it("reuses canonical owner and returns no roles while workbench is disabled", async () => {
    const f = fixture(),
      receipt = await f.request(),
      result = await f.confirm(receipt);
    expect(result.user).toMatchObject({
      id: "user",
      phoneVerified: true,
      memberships: [],
    });
    expect(f.tx.user.create).not.toHaveBeenCalled();
    expect(f.phones.lock).toHaveBeenCalledTimes(2);
    const data = f.tx.session.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      authChannel: "TECHNICIAN_PHONE",
      authProvider: "technician-sms",
      customerPhoneHash: f.phones.hash(phone),
    });
    expect(data.staffVerifiedUntil).toBeUndefined();
    expect(data.mfaVerifiedUntil).toBeUndefined();
    expect(data.wechatIdentityId).toBeUndefined();
    expect(data.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(86400000);
  });
  it("creates only a CUSTOMER canonical phone user, not memberships or WeChat bindings", async () => {
    const f = fixture();
    f.phones.findOwner.mockResolvedValue(null as never);
    const receipt = await f.request();
    await f.confirm(receipt);
    expect(f.tx.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ role: "CUSTOMER" }),
      select: { id: true },
    });
    expect(f.phones.register).toHaveBeenCalledWith(f.tx, "user", phone);
  });
  it("exposes only the approved profile organization THERAPIST role with separate workbench opt-in", async () => {
    const f = fixture({ TECHNICIAN_PHONE_WORKBENCH_ENABLED: "true" }),
      receipt = await f.request();
    expect((await f.confirm(receipt)).user.memberships).toEqual([
      { organizationId: "org", role: "THERAPIST" },
    ]);
  });
  it.each(["DRAFT", "PENDING_REVIEW", "REJECTED"])(
    "does not return membership for %s",
    async (status) => {
      const f = fixture({ TECHNICIAN_PHONE_WORKBENCH_ENABLED: "true" });
      f.user.technicianProfile.status = status;
      expect((await f.confirm(await f.request())).user.memberships).toEqual([]);
    },
  );
  it.each(["phone", "challengeSecret", "challengeId"])(
    "wrong %s never resolves identity",
    async (field) => {
      const f = fixture(),
        receipt = await f.request();
      await expect(
        f.confirm(receipt, {
          [field]: field === "phone" ? "13900139000" : "x".repeat(43),
        }),
      ).rejects.toThrow("验证码无效");
      expect(f.phones.findOwner).not.toHaveBeenCalled();
    },
  );
  it("commits five failed code attempts, blocks correct code afterward, and enforces replay", async () => {
    const f = fixture(),
      receipt = await f.request();
    for (let i = 0; i < 5; i++)
      await expect(f.confirm(receipt, { code: "000000" })).rejects.toThrow(
        "验证码无效",
      );
    expect(f.proofs.get(receipt.challengeId).attempts).toBe(5);
    await expect(f.confirm(receipt)).rejects.toThrow("尝试次数过多");
    const g = fixture(),
      proof = await g.request();
    await g.confirm(proof);
    await expect(g.confirm(proof)).rejects.toThrow("验证码无效");
    expect(g.tx.session.create).toHaveBeenCalledTimes(1);
  });
  it("rejects expired proof without user resolution", async () => {
    const f = fixture(),
      receipt = await f.request();
    f.proofs.get(receipt.challengeId).expiresAt = new Date(0);
    await expect(f.confirm(receipt)).rejects.toThrow("已过期");
    expect(f.phones.findOwner).not.toHaveBeenCalled();
  });
  it("preserves UNKNOWN as confirmable and never retries ambiguous provider calls", async () => {
    const f = fixture();
    f.sms.submitPhoneVerification.mockResolvedValue({
      status: "UNKNOWN",
    } as never);
    await f.confirm(await f.request());
    expect(f.sms.submitPhoneVerification).toHaveBeenCalledTimes(1);
  });
  it("handles REJECTED and thrown provider failures without echoing provider secrets", async () => {
    for (const thrown of [false, true]) {
      const f = fixture();
      if (thrown)
        f.sms.submitPhoneVerification.mockRejectedValue(
          Error("secret-upstream-payload"),
        );
      else
        f.sms.submitPhoneVerification.mockResolvedValue({
          status: "REJECTED",
        } as never);
      await expect(f.request()).rejects.toThrow("验证码暂未发送");
      expect(f.tx.session.create).not.toHaveBeenCalled();
      expect([...f.proofs.values()][0].status).toBe("REJECTED");
    }
  });
  it("rejects cooldown and rate limit before any chargeable send", async () => {
    const f = fixture();
    f.tx.technicianPhoneLoginChallenge.findFirst.mockResolvedValue({
      id: "recent",
    } as never);
    await expect(f.request()).rejects.toThrow("60秒");
    expect(f.sms.submitPhoneVerification).not.toHaveBeenCalled();
    const g = fixture();
    g.tx.phoneVerificationRateLimit.upsert.mockResolvedValue({ count: 999 });
    await expect(g.request()).rejects.toThrow("频繁");
    expect(g.sms.submitPhoneVerification).not.toHaveBeenCalled();
  });
  it("rejects disabled or rebound canonical user after valid proof", async () => {
    for (const fields of [
      { status: "DISABLED" },
      { phoneVerifiedAt: null },
      { phoneEncrypted: "broken-ciphertext" },
    ]) {
      const f = fixture();
      Object.assign(f.user, fields);
      await expect(f.confirm(await f.request())).rejects.toThrow();
      expect(f.tx.session.create).not.toHaveBeenCalled();
    }
  });
  it("strict controller schema rejects empty and identity-injecting requests without SMS", async () => {
    const f = fixture(),
      controller = new TechnicianPhoneAuthController(f.service);
    for (const body of [{}, { phone, agreementsAccepted: true, role: "ADMIN" }])
      await expect(controller.request(body, { ip } as never)).rejects.toThrow();
    await expect(controller.confirm({}, { ip } as never)).rejects.toThrow();
    expect(f.sms.submitPhoneVerification).not.toHaveBeenCalled();
    expect(
      TechnicianPhoneSmsConfirmSchema.safeParse({
        phone,
        challengeId: "x",
        challengeSecret: "x".repeat(43),
        code: "123456",
        agreementsAccepted: true,
      }).success,
    ).toBe(false);
  });
  it("allows partial valid drafts but never identity, status or organization injection", () => {
    expect(
      TechnicianPhoneProfileDraftSchema.safeParse({ bio: "" }).success,
    ).toBe(true);
    expect(
      TechnicianPhoneProfileDraftSchema.safeParse({
        realName: "",
        serviceIds: [],
      }).success,
    ).toBe(true);
    for (const data of [
      {},
      { status: "APPROVED" },
      { realName: "Test", organizationId: "other" },
    ])
      expect(TechnicianPhoneProfileDraftSchema.safeParse(data).success).toBe(
        false,
      );
  });
});

describe("technician phone session lifecycle and route isolation", () => {
  function authFixture() {
    const f = fixture({ TECHNICIAN_PHONE_WORKBENCH_ENABLED: "true" });
    const session: any = {
      id: "session",
      userId: "user",
      authChannel: "TECHNICIAN_PHONE",
      authProvider: "technician-sms",
      customerPhoneHash: f.phones.hash(phone),
      expiresAt: new Date(Date.now() + 60000),
      revokedAt: null,
      user: f.user,
    };
    f.prisma.session.findUnique = vi.fn(async () => session);
    f.prisma.session.update = vi.fn();
    const auth = new AuthService(
      f.prisma,
      f.crypto,
      {} as never,
      f.config as never,
    );
    return { ...f, session, auth };
  }
  it("rechecks approved profile and active membership on every authenticate call", async () => {
    const f = authFixture();
    expect((await f.auth.authenticate("x".repeat(43))).memberships).toEqual([
      { organizationId: "org", role: "THERAPIST" },
    ]);
    f.user.technicianProfile.status = "REJECTED";
    expect((await f.auth.authenticate("x".repeat(43))).memberships).toEqual([]);
    f.user.technicianProfile.status = "APPROVED";
    f.user.memberships = [];
    expect((await f.auth.authenticate("x".repeat(43))).memberships).toEqual([]);
  });
  it.each([
    "wechatIdentityId",
    "staffVerifiedUntil",
    "staffVerificationMethod",
    "mfaVerifiedUntil",
    "trustedDeviceId",
    "staffPasswordVersion",
  ])("rejects forged %s grant", async (field) => {
    const f = authFixture();
    f.session[field] = "forged";
    await expect(f.auth.authenticate("x".repeat(43))).rejects.toThrow(
      "登录已失效",
    );
  });
  it.each(["disabled", "rebound", "source", "binding", "gate", "revoked"])(
    "invalidates %s session",
    async (issue) => {
      const f = authFixture();
      if (issue === "disabled") f.user.status = "DISABLED";
      if (issue === "rebound")
        f.user.phoneEncrypted = f.crypto.encrypt("13900139000");
      if (issue === "source") f.session.authProvider = "customer-sms";
      if (issue === "binding")
        f.prisma.customerPhoneIdentity.findUnique.mockResolvedValue(null);
      if (issue === "gate")
        f.config.set("TECHNICIAN_PHONE_LOGIN_ENABLED", "false");
      if (issue === "revoked") f.session.revokedAt = new Date();
      await expect(f.auth.authenticate("x".repeat(43))).rejects.toThrow();
    },
  );
  it.each([
    ["GET", "/auth/mfa"],
    ["POST", "/auth/mfa/verify"],
    ["GET", "/admin/organizations/org/technicians"],
    ["POST", "/admin/organizations/org/technicians/a/profile/approve"],
    ["GET", "/orders"],
    ["POST", "/customer-center/wallet/recharges"],
    ["GET", "/technician/onboarding"],
    ["POST", "/future-staff-operation"],
  ])("denies %s %s regardless of workbench opt-in", (method, path) => {
    expect(technicianPhoneRouteAllowed(method!, path!, true)).toBe(false);
  });
  it("allows only exact own endpoints and does not broaden customer SMS", () => {
    expect(
      technicianPhoneRouteAllowed(
        "GET",
        "/v1/technician/phone-onboarding/status",
        false,
      ),
    ).toBe(true);
    expect(
      technicianPhoneRouteAllowed(
        "PATCH",
        "/technician/phone-onboarding/profile",
        false,
      ),
    ).toBe(true);
    expect(
      technicianPhoneRouteAllowed("GET", "/technician/workbench", false),
    ).toBe(false);
    expect(
      technicianPhoneRouteAllowed("GET", "/technician/workbench", true),
    ).toBe(true);
    expect(
      technicianPhoneRouteAllowed(
        "POST",
        "/technician/workbench/orders/:orderId/actions",
        true,
      ),
    ).toBe(true);
    expect(
      technicianPhoneRouteAllowed(
        "GET",
        "/technician/workbench/profile/photos/:photoId",
        false,
      ),
    ).toBe(true);
    expect(
      customerSmsRouteAllowed("GET", "/technician/phone-onboarding/status"),
    ).toBe(false);
  });
  it("guard denies new-source admin and MFA even with spoofed elevated memberships", async () => {
    const guard = new SessionAuthGuard(
      {
        authenticate: vi
          .fn()
          .mockResolvedValue({
            authChannel: "TECHNICIAN_PHONE",
            authProvider: "technician-sms",
            memberships: [{ role: "ADMIN", organizationId: "org" }],
            mfaVerifiedUntil: new Date(Date.now() + 60000),
          }),
      } as never,
      new ConfigService({
        TECHNICIAN_PHONE_LOGIN_ENABLED: "true",
        TECHNICIAN_PHONE_WORKBENCH_ENABLED: "true",
      }),
    );
    for (const url of [
      "/v1/auth/mfa",
      "/v1/admin/organizations/org/technicians",
    ])
      await expect(
        guard.canActivate({
          switchToHttp: () => ({
            getRequest: () => ({
              headers: { authorization: "Bearer fixture" },
              method: "GET",
              routeOptions: { url },
            }),
          }),
        } as never),
      ).rejects.toThrow("仅可用于本人");
  });
});
