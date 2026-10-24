import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../config/env.js";
import { AuthCryptoService } from "./auth-crypto.service.js";
import { CustomerLoginService } from "./customer-login.service.js";

const phone = "13800138000";
const settings = {
  NODE_ENV: "test",
  AUTH_PROVIDER: "mock",
  WECHAT_MINIAPP_APP_ID: "wx-fixture",
  AUTH_SESSION_TTL_SECONDS: 600,
  DATA_ENCRYPTION_KEY_BASE64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  AUTH_SESSION_PEPPER: "unit-test-customer-login-pepper-not-production",
  CUSTOMER_SMS_LOGIN_ENABLED: "true",
  PHONE_VERIFICATION_SMS_ENABLED: "true",
  SMS_PROVIDER: "aliyun",
  SMS_SEND_ENABLED: "true",
  ALIYUN_SMS_ACCESS_KEY_ID: "test-placeholder",
  ALIYUN_SMS_ACCESS_KEY_SECRET: "test-placeholder-not-real",
  ALIYUN_SMS_SIGN_NAME: "测试签名",
  ALIYUN_SMS_PHONE_VERIFICATION_TEMPLATE_CODE: "SMS_FIXTURE",
};
const fixture = (overrides = {}) => {
  const config = new ConfigService({
    ...settings,
    ...overrides,
  }) as ConfigService<AppEnv, true>;
  const crypto = new AuthCryptoService(config);
  const user = {
    id: "existing-user",
    role: "CUSTOMER",
    status: "ACTIVE",
    displayName: "老客户",
    phoneEncrypted: crypto.encrypt(phone),
    phoneVerifiedAt: new Date(),
    memberships: [
      { organizationId: "org", role: "CUSTOMER" },
      { organizationId: "org", role: "OPERATOR" },
    ],
  };
  const challengeStore = new Map<string, any>();
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi.fn().mockResolvedValue([]),
    user: {
      findUnique: vi.fn().mockResolvedValue(user),
      create: vi.fn().mockResolvedValue({ id: user.id }),
      update: vi.fn(),
    },
    externalIdentity: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async (input) => ({
        id: "current-wechat-id",
        ...input.data,
      })),
      update: vi.fn().mockImplementation(async (input) => ({
        id: input.where.id,
        ...input.data,
      })),
      updateMany: vi.fn(),
    },
    wechatUnionIdentity: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
    },
    session: { create: vi.fn(), updateMany: vi.fn() },
    auditLog: { create: vi.fn() },
    phoneVerificationRateLimit: {
      upsert: vi.fn().mockResolvedValue({ count: 1 }),
    },
    customerSmsLoginChallenge: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async (input) => {
        challengeStore.set(input.data.id, {
          ...input.data,
          createdAt: new Date(),
          status: "PENDING",
          attempts: 0,
          consumedAt: null,
        });
      }),
      findUnique: vi
        .fn()
        .mockImplementation(
          async (input) => challengeStore.get(input.where.id) ?? null,
        ),
      update: vi.fn().mockImplementation(async (input) => {
        const item = challengeStore.get(input.where.id);
        if (item)
          Object.assign(item, {
            ...input.data,
            ...(input.data.attempts
              ? { attempts: item.attempts + input.data.attempts.increment }
              : {}),
          });
        return item;
      }),
      updateMany: vi.fn().mockImplementation(async (input) => {
        const item = challengeStore.get(input.where.id);
        if (!item || item.consumedAt) return { count: 0 };
        Object.assign(item, input.data);
        return { count: 1 };
      }),
    },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(
      async (callback, _options?: { timeout: number; maxWait: number }) =>
        callback(tx),
    ),
  };
  const phones = {
    hash: (value: string) => crypto.hashPhoneVerification("phone", value),
    lock: vi.fn(),
    findOwner: vi.fn().mockResolvedValue(user.id),
    register: vi.fn(),
    hasStaffAuthority: vi.fn().mockResolvedValue(false),
    canAttachFirstWechatToPhoneTechnician: vi.fn().mockResolvedValue(false),
  };
  const wechat = {
    exchangeCode: vi.fn().mockResolvedValue({ openId: "current-openid" }),
    exchangePhoneCode: vi.fn().mockResolvedValue({ phoneNumber: phone }),
  };
  const sms = {
    submitPhoneVerification: vi.fn().mockResolvedValue({
      status: "ACCEPTED",
      requestId: "provider-request",
      bizId: "provider-biz",
    }),
  };
  const service = new CustomerLoginService(
    prisma as never,
    crypto,
    wechat as never,
    config,
    phones as never,
    sms as never,
  );
  return {
    service,
    tx,
    prisma,
    phones,
    crypto,
    wechat,
    sms,
    user,
    challengeStore,
  };
};
const wechatInput = {
  code: "wx-one-use-login",
  phoneCode: "wx-one-use-phone",
  agreementsAccepted: true as const,
};
const smsInput = { phone, agreementsAccepted: true as const };

describe("CustomerLoginService", () => {
  it("binds a phone-onboarded technician's first verified WeChat to the same account only", async () => {
    const f = fixture({ TECHNICIAN_PHONE_LOGIN_ENABLED: "true" });
    f.phones.hasStaffAuthority.mockResolvedValue(true);
    f.phones.canAttachFirstWechatToPhoneTechnician.mockResolvedValue(true);
    const result = await f.service.wechatPhone(wechatInput);
    expect(result.user.id).toBe(f.user.id);
    expect(f.tx.user.create).not.toHaveBeenCalled();
    expect(f.tx.externalIdentity.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: f.user.id }),
      }),
    );
  });
  it("reports unavailable SMS without exposing missing secret names or values", () => {
    const f = fixture({ CUSTOMER_SMS_LOGIN_ENABLED: "false" });
    expect(f.service.capabilities()).toEqual({
      wechatPhoneLoginEnabled: true,
      smsLoginEnabled: false,
      smsUnavailableReason: "短信登录尚未开通，请使用微信一键登录",
    });
  });
  it("fails closed for production mock or unconfigured WeChat", async () => {
    const f = fixture({ NODE_ENV: "production" });
    expect(f.service.capabilities().wechatPhoneLoginEnabled).toBe(false);
    await expect(f.service.wechatPhone(wechatInput)).rejects.toThrow(
      "尚未就绪",
    );
    expect(f.wechat.exchangeCode).not.toHaveBeenCalled();
    expect(
      fixture({
        AUTH_PROVIDER: "wechat",
        WECHAT_MINIAPP_SECRET: "",
      }).service.capabilities().wechatPhoneLoginEnabled,
    ).toBe(false);
  });
  it("checks every SMS gate before persisting a challenge or invoking the sender", async () => {
    for (const overrides of [
      { CUSTOMER_SMS_LOGIN_ENABLED: "false" },
      { SMS_SEND_ENABLED: "false" },
      { PHONE_VERIFICATION_SMS_ENABLED: "false" },
      { ALIYUN_SMS_ACCESS_KEY_SECRET: "" },
      { ALIYUN_SMS_PHONE_VERIFICATION_TEMPLATE_CODE: "" },
    ]) {
      const f = fixture(overrides);
      await expect(f.service.requestSms(smsInput, "127.0.0.1")).rejects.toThrow(
        "尚未开通",
      );
      expect(f.tx.customerSmsLoginChallenge.create).not.toHaveBeenCalled();
      expect(f.sms.submitPhoneVerification).not.toHaveBeenCalled();
    }
  });
  it("requires agreements even when called without controller schemas", async () => {
    const f = fixture();
    await expect(
      f.service.wechatPhone({
        ...wechatInput,
        agreementsAccepted: false,
      } as never),
    ).rejects.toThrow("用户协议");
    await expect(
      f.service.requestSms(
        { ...smsInput, agreementsAccepted: false } as never,
        "127.0.0.1",
      ),
    ).rejects.toThrow("用户协议");
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
  it("combines real code+phone exchange, reuses canonical user and pins the authorized identity without mutating assets", async () => {
    const f = fixture();
    const result = await f.service.wechatPhone(wechatInput);
    expect(result.user.id).toBe(f.user.id);
    expect(result.user.phoneVerified).toBe(true);
    expect(f.wechat.exchangeCode).toHaveBeenCalledWith(wechatInput.code);
    expect(f.wechat.exchangePhoneCode).toHaveBeenCalledWith(
      wechatInput.phoneCode,
    );
    expect(f.tx.user.create).not.toHaveBeenCalled();
    expect(f.tx.session.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: f.user.id,
        wechatIdentityId: "current-wechat-id",
        authProvider: "mock",
        authChannel: "WECHAT_MINIAPP",
      }),
    });
    expect(JSON.stringify(result)).not.toContain("current-openid");
    expect(JSON.stringify(f.tx.auditLog.create.mock.calls)).not.toContain(
      phone,
    );
    expect(f.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 15000,
      maxWait: 5000,
    });
    expect(
      f.tx.$executeRaw.mock.calls.slice(0, 3).map((call) => call[0].join("")),
    ).toEqual([
      "SET LOCAL lock_timeout = '10000ms'",
      "SET LOCAL statement_timeout = '12000ms'",
      "SET LOCAL idle_in_transaction_session_timeout = '12000ms'",
    ]);
  });
  it("blocks attaching a different WeChat identity to a staff-owned phone", async () => {
    const f = fixture();
    f.phones.hasStaffAuthority.mockResolvedValue(true);
    await expect(f.service.wechatPhone(wechatInput)).rejects.toMatchObject({
      response: { code: "ACCOUNT_LINK_CONFLICT" },
    });
    expect(f.tx.externalIdentity.create).not.toHaveBeenCalled();
    expect(f.tx.session.create).not.toHaveBeenCalled();
  });
  it("retains historical UnionID when a same-OpenID exchange legitimately omits it", async () => {
    const f = fixture();
    const historical = {
      id: "historical-identity",
      userId: f.user.id,
      unionIdHash: "historical-union",
      unionIdEncrypted: f.crypto.encrypt("historical-union-value"),
    };
    f.tx.externalIdentity.findUnique.mockResolvedValue(historical as never);
    f.tx.wechatUnionIdentity.findUnique.mockResolvedValue({
      userId: f.user.id,
      unionIdHash: historical.unionIdHash,
      unionIdEncrypted: historical.unionIdEncrypted,
    } as never);
    await expect(f.service.wechatPhone(wechatInput)).resolves.toMatchObject({
      user: { id: f.user.id },
    });
    expect(f.tx.externalIdentity.update).toHaveBeenCalledWith({
      where: { id: historical.id },
      data: {
        userId: f.user.id,
        unionIdHash: historical.unionIdHash,
        unionIdEncrypted: historical.unionIdEncrypted,
      },
    });
    expect(f.tx.wechatUnionIdentity.create).not.toHaveBeenCalled();
    expect(f.tx.wechatUnionIdentity.findUnique).toHaveBeenCalledWith({
      where: { unionIdHash: historical.unionIdHash },
    });
  });
  it("preserves every existing-user identity and UnionID when a different canonical owner conflicts", async () => {
    const f = fixture();
    const historical = {
      id: "shell-identity",
      userId: "empty-shell",
      unionIdHash: "shell-union",
      unionIdEncrypted: f.crypto.encrypt("shell-union-value"),
    };
    f.tx.externalIdentity.findUnique.mockResolvedValue(historical as never);
    f.tx.wechatUnionIdentity.findUnique.mockImplementation(async (input) =>
      input.where.unionIdHash
        ? {
            userId: "empty-shell",
            unionIdHash: historical.unionIdHash,
            unionIdEncrypted: historical.unionIdEncrypted,
          }
        : null,
    );
    await expect(f.service.wechatPhone(wechatInput)).rejects.toMatchObject({
      response: { code: "ACCOUNT_LINK_CONFLICT" },
    });
    expect(f.tx.wechatUnionIdentity.update).not.toHaveBeenCalled();
    expect(f.tx.externalIdentity.update).not.toHaveBeenCalled();
    expect(f.tx.session.updateMany).not.toHaveBeenCalled();
  });
  it("blocks asset-bearing legacy account conflicts, never transferring ownership rows", async () => {
    const f = fixture();
    f.tx.externalIdentity.findUnique.mockResolvedValue({
      id: "old-identity",
      userId: "old-user",
      unionIdHash: null,
    } as never);
    await expect(f.service.wechatPhone(wechatInput)).rejects.toMatchObject({
      response: { code: "ACCOUNT_LINK_CONFLICT" },
    });
    expect(f.tx.externalIdentity.updateMany).not.toHaveBeenCalled();
    expect(f.tx.user.update).not.toHaveBeenCalled();
    expect(f.tx.session.create).not.toHaveBeenCalled();
  });
  it("does not retire even an apparently empty legacy user or revoke its legitimate sessions", async () => {
    const f = fixture();
    f.tx.externalIdentity.findUnique.mockResolvedValue({
      id: "old-identity",
      userId: "empty-user",
      unionIdHash: null,
    } as never);
    await expect(f.service.wechatPhone(wechatInput)).rejects.toMatchObject({
      response: { code: "ACCOUNT_LINK_CONFLICT" },
    });
    expect(f.tx.session.updateMany).not.toHaveBeenCalled();
    expect(f.tx.user.update).not.toHaveBeenCalled();
    expect(f.tx.externalIdentity.updateMany).not.toHaveBeenCalled();
  });
  it("stores only encrypted phone and challenge-bound keyed code hashes", async () => {
    const f = fixture();
    const result = await f.service.requestSms(smsInput, "127.0.0.1");
    expect(result.status).toBe("SENT");
    const stored = f.challengeStore.get(result.challengeId);
    expect(stored.phoneEncrypted).not.toBe(phone);
    expect(f.crypto.decrypt(stored.phoneEncrypted)).toBe(phone);
    const sentCode = f.sms.submitPhoneVerification.mock.calls[0]![0].code;
    expect(stored.codeHash).not.toBe(sentCode);
    expect(stored.codeHash).toBe(
      f.crypto.hashPhoneVerification(
        "customer-login-code",
        `${result.challengeId}:${sentCode}`,
      ),
    );
    expect(JSON.stringify(result)).not.toContain(sentCode);
  });
  it("retains a durable UNKNOWN challenge on uncertain delivery, never silently resends", async () => {
    const f = fixture();
    f.sms.submitPhoneVerification.mockResolvedValue({
      status: "UNKNOWN",
    } as never);
    const result = await f.service.requestSms(smsInput, "127.0.0.1");
    expect(result.status).toBe("UNKNOWN");
    expect(f.sms.submitPhoneVerification).toHaveBeenCalledTimes(1);
    f.tx.customerSmsLoginChallenge.findFirst.mockResolvedValue({
      id: result.challengeId,
    } as never);
    await expect(f.service.requestSms(smsInput, "127.0.0.1")).rejects.toThrow(
      "60 秒",
    );
    expect(f.sms.submitPhoneVerification).toHaveBeenCalledTimes(1);
  });
  it("SMS login preserves canonical ID but strips all staff authority and WeChat payment identity", async () => {
    const f = fixture();
    const request = await f.service.requestSms(smsInput, "127.0.0.1");
    const code = f.sms.submitPhoneVerification.mock.calls[0]![0].code;
    const result = await f.service.confirmSms(
      { ...smsInput, challengeId: request.challengeId, code },
      "127.0.0.1",
    );
    expect(result.user.id).toBe(f.user.id);
    expect(result.user.memberships).toEqual([
      { organizationId: "org", role: "CUSTOMER" },
    ]);
    expect(f.tx.user.create).not.toHaveBeenCalled();
    expect(f.tx.session.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        authChannel: "CUSTOMER_SMS",
        authProvider: "customer-sms",
        wechatIdentityId: null,
        userId: f.user.id,
      }),
    });
    expect(f.tx.session.create.mock.calls[0]![0].data.customerPhoneHash).toBe(
      f.phones.hash(phone),
    );
    await expect(
      f.service.confirmSms(
        { ...smsInput, challengeId: request.challengeId, code },
        "127.0.0.1",
      ),
    ).rejects.toThrow("已使用");
    expect(f.tx.session.create).toHaveBeenCalledTimes(1);
    expect(
      f.prisma.$transaction.mock.calls.every(
        (call) => call[1]?.timeout === 15000 && call[1]?.maxWait === 5000,
      ),
    ).toBe(true);
  });
  it("caps bad code guesses at five and commits failed attempts", async () => {
    const f = fixture();
    const request = await f.service.requestSms(smsInput, "127.0.0.1");
    const correct = f.sms.submitPhoneVerification.mock.calls[0]![0].code;
    const wrong = correct === "123456" ? "654321" : "123456";
    for (let i = 0; i < 5; i++)
      await expect(
        f.service.confirmSms(
          { ...smsInput, challengeId: request.challengeId, code: wrong },
          "127.0.0.1",
        ),
      ).rejects.toThrow("无效");
    expect(f.challengeStore.get(request.challengeId).attempts).toBe(5);
    await expect(
      f.service.confirmSms(
        { ...smsInput, challengeId: request.challengeId, code: correct },
        "127.0.0.1",
      ),
    ).rejects.toThrow("尝试次数");
    expect(f.tx.session.create).not.toHaveBeenCalled();
  });
  it("rejects expiry, phone substitution and source rate limits", async () => {
    const f = fixture();
    const request = await f.service.requestSms(smsInput, "127.0.0.1");
    const code = f.sms.submitPhoneVerification.mock.calls[0]![0].code;
    await expect(
      f.service.confirmSms(
        {
          ...smsInput,
          phone: "13900139000",
          challengeId: request.challengeId,
          code,
        },
        "127.0.0.1",
      ),
    ).rejects.toThrow("无效");
    f.challengeStore.get(request.challengeId).expiresAt = new Date(
      Date.now() - 1,
    );
    await expect(
      f.service.confirmSms(
        { ...smsInput, challengeId: request.challengeId, code },
        "127.0.0.1",
      ),
    ).rejects.toThrow("已过期");
    f.tx.phoneVerificationRateLimit.upsert.mockResolvedValue({ count: 101 });
    await expect(f.service.requestSms(smsInput, "127.0.0.1")).rejects.toThrow(
      "过于频繁",
    );
  });
  it("bounds provider costs globally before any anonymous dispatch", async () => {
    const f = fixture();
    const globalKey = f.crypto.hashPhoneVerification(
      "customer-login-rate:request-global-minute",
      new Date().toISOString().slice(0, 16),
    );
    f.tx.phoneVerificationRateLimit.upsert.mockImplementation(
      async (input) => ({ count: input.where.key === globalKey ? 51 : 1 }),
    );
    await expect(
      f.service.requestSms(smsInput, "198.51.100.99"),
    ).rejects.toThrow("过于频繁");
    expect(f.sms.submitPhoneVerification).not.toHaveBeenCalled();
    expect(f.tx.customerSmsLoginChallenge.create).not.toHaveBeenCalled();
  });
  it("reports bounded transaction contention safely without re-consuming authorization or dispatching SMS", async () => {
    const f = fixture();
    f.prisma.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError(
        "sensitive fixture contents must never escape",
        { code: "P2028", clientVersion: "test" },
      ),
    );
    await expect(f.service.wechatPhone(wechatInput)).rejects.toMatchObject({
      response: {
        code: "LOGIN_BUSY",
        message: "登录请求较多，请稍后重新点击登录",
      },
    });
    expect(f.wechat.exchangeCode).toHaveBeenCalledTimes(1);
    expect(f.wechat.exchangePhoneCode).toHaveBeenCalledTimes(1);
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(1);
    await expect(
      f.service.requestSms(smsInput, "127.0.0.1"),
    ).rejects.toMatchObject({ response: { code: "LOGIN_BUSY" } });
    expect(f.sms.submitPhoneVerification).not.toHaveBeenCalled();
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(2);
  });
  it("translates server lock/cancellation/idle expiry codes into safe login errors without retrying", async () => {
    for (const sqlState of ["55P03", "57014", "25P03"]) {
      const f = fixture();
      f.prisma.$transaction.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError(
          "provider message with private metadata",
          {
            code: "P2010",
            clientVersion: "test",
            meta: {
              code: sqlState,
              message: "private metadata must not escape",
            },
          },
        ),
      );
      await expect(f.service.wechatPhone(wechatInput)).rejects.toMatchObject({
        response: {
          code: "LOGIN_BUSY",
          message: "登录请求较多，请稍后重新点击登录",
        },
      });
      expect(f.wechat.exchangeCode).toHaveBeenCalledTimes(1);
      expect(f.prisma.$transaction).toHaveBeenCalledTimes(1);
    }
  });
  it("initializes all SMS transaction server budgets before challenge processing or dispatch", async () => {
    const f = fixture();
    const response = await f.service.requestSms(smsInput, "127.0.0.1");
    const statements = () =>
      f.tx.$executeRaw.mock.calls.map((call) => call[0].join(""));
    const expected = [
      "SET LOCAL lock_timeout = '10000ms'",
      "SET LOCAL statement_timeout = '12000ms'",
      "SET LOCAL idle_in_transaction_session_timeout = '12000ms'",
    ];
    expect(statements().slice(0, 3)).toEqual(expected);
    const before = statements().length;
    const code = f.sms.submitPhoneVerification.mock.calls[0]![0].code;
    await f.service.confirmSms(
      { ...smsInput, challengeId: response.challengeId, code },
      "127.0.0.1",
    );
    expect(statements().slice(before, before + 3)).toEqual(expected);
    expect(f.sms.submitPhoneVerification).toHaveBeenCalledTimes(1);
  });
});
