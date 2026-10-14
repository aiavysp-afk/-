import { describe, expect, it, vi } from "vitest";
import { CustomerLoginController } from "./customer-login.controller.js";

const fixture = () => {
  const service = {
    capabilities: vi
      .fn()
      .mockReturnValue({
        wechatPhoneLoginEnabled: true,
        smsLoginEnabled: false,
      }),
    wechatPhone: vi.fn().mockResolvedValue({ opaque: true }),
    requestSms: vi.fn().mockResolvedValue({ challengeId: "a".repeat(36) }),
    confirmSms: vi.fn().mockResolvedValue({ opaque: true }),
  };
  return { controller: new CustomerLoginController(service as never), service };
};
describe("CustomerLoginController", () => {
  it("returns only server capabilities", () => {
    const f = fixture();
    expect(f.controller.capabilities()).toEqual({
      data: { wechatPhoneLoginEnabled: true, smsLoginEnabled: false },
    });
  });
  it("requires all legal consents and rejects client-supplied identity or role", async () => {
    const f = fixture();
    for (const body of [
      { code: "code", phoneCode: "phone" },
      { code: "code", phoneCode: "phone", agreementsAccepted: false },
      {
        code: "code",
        phoneCode: "phone",
        agreementsAccepted: true,
        userId: "other",
      },
      {
        code: "code",
        phoneCode: "phone",
        agreementsAccepted: true,
        role: "ADMIN",
      },
    ])
      await expect(f.controller.wechatPhone(body)).rejects.toThrow("协议");
    expect(f.service.wechatPhone).not.toHaveBeenCalled();
  });
  it("passes only the two authorization codes and accepted consent", async () => {
    const f = fixture();
    const input = {
      code: "one-use-login",
      phoneCode: "one-use-phone",
      agreementsAccepted: true,
    };
    await expect(f.controller.wechatPhone(input)).resolves.toEqual({
      data: { opaque: true },
    });
    expect(f.service.wechatPhone).toHaveBeenCalledWith(input);
  });
  it("SMS accepts anonymous requests but gets rate-limit IP only from Fastify", async () => {
    const f = fixture();
    const input = { phone: "13800138000", agreementsAccepted: true };
    await f.controller.requestSms(input, { ip: "198.51.100.1" } as never);
    expect(f.service.requestSms).toHaveBeenCalledWith(input, "198.51.100.1");
    await expect(
      f.controller.requestSms({ ...input, ip: "trusted-fake" }, {
        ip: "198.51.100.1",
      } as never),
    ).rejects.toThrow("协议");
  });
  it("requires an explicit challenge ID and six-digit OTP, never accepts staff-code purposes", async () => {
    const f = fixture();
    const input = {
      phone: "13800138000",
      agreementsAccepted: true,
      code: "123456",
      challengeId: "a".repeat(36),
    };
    await f.controller.confirmSms(input, { ip: "198.51.100.1" } as never);
    expect(f.service.confirmSms).toHaveBeenCalledWith(input, "198.51.100.1");
    await expect(
      f.controller.confirmSms({ ...input, purpose: "staff-password" }, {
        ip: "198.51.100.1",
      } as never),
    ).rejects.toThrow("参数无效");
    await expect(
      f.controller.confirmSms({ ...input, challengeId: undefined }, {
        ip: "198.51.100.1",
      } as never),
    ).rejects.toThrow("参数无效");
  });
});
