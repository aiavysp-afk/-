import { describe, expect, it } from "vitest";
import {
  CustomerLoginCapabilitiesSchema,
  CustomerSmsLoginConfirmSchema,
  CustomerSmsLoginRequestResultSchema,
  CustomerSmsLoginRequestSchema,
  CustomerWechatPhoneLoginRequestSchema,
} from "./index.js";

describe("customer login contracts", () => {
  const wechat = {
    code: "wechat-session-code",
    phoneCode: "separate-phone-code",
    agreementsAccepted: true,
  };
  const phone = { phone: "13800138000", agreementsAccepted: true };
  it("requires explicit consent for both login choices", () => {
    for (const schema of [
      CustomerWechatPhoneLoginRequestSchema,
      CustomerSmsLoginRequestSchema,
    ]) {
      const value =
        schema === CustomerWechatPhoneLoginRequestSchema ? wechat : phone;
      expect(schema.safeParse(value).success).toBe(true);
      for (const accepted of [undefined, false, "true", 1])
        expect(
          schema.safeParse({ ...value, agreementsAccepted: accepted }).success,
        ).toBe(false);
    }
  });
  it("accepts distinct authorized WeChat and phone codes, never a user-supplied identity", () => {
    for (const extra of [
      { userId: "victim" },
      { openId: "forged" },
      { phone: "13800138000" },
      { role: "ADMIN" },
    ])
      expect(
        CustomerWechatPhoneLoginRequestSchema.safeParse({ ...wechat, ...extra })
          .success,
      ).toBe(false);
    expect(
      CustomerWechatPhoneLoginRequestSchema.safeParse({
        ...wechat,
        phoneCode: "",
      }).success,
    ).toBe(false);
  });
  it("requires an independent SMS challenge and exact six digits", () => {
    const value = {
      ...phone,
      challengeId: "customer-challenge-123456",
      code: "012345",
    };
    expect(CustomerSmsLoginConfirmSchema.parse(value)).toEqual(value);
    for (const extra of [
      { challengeId: undefined },
      { challengeId: "short" },
      { code: "1234" },
      { code: "12a456" },
      { phone: "+8613800138000" },
      { userId: "victim" },
    ])
      expect(
        CustomerSmsLoginConfirmSchema.safeParse({ ...value, ...extra }).success,
      ).toBe(false);
  });
  it("makes unknown send outcomes distinct from confirmed sends without exposing a code", () => {
    const parsed = CustomerSmsLoginRequestResultSchema.parse({
      challengeId: "customer-challenge-123456",
      status: "UNKNOWN",
      expiresAt: "2026-10-14T03:00:00.000Z",
      retryAfterSeconds: 60,
      code: "123456",
    });
    expect(parsed.status).toBe("UNKNOWN");
    expect(parsed).not.toHaveProperty("code");
    expect(
      CustomerLoginCapabilitiesSchema.parse({
        wechatPhoneLoginEnabled: true,
        smsLoginEnabled: false,
        smsUnavailableReason: "暂未开通",
      }),
    ).toMatchObject({ smsLoginEnabled: false });
  });
});
