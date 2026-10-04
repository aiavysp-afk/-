import { describe, expect, it } from "vitest";
import { validateEnv } from "../config/env.js";
import { customerServiceConfig } from "./customer-service.config.js";
import { WecomCustomerServiceUrlSchema } from "@zydj/contracts";

const settings = {
  CUSTOMER_SERVICE_PROVIDER: "wecom",
  WECOM_CORP_ID: "ww1234567890abcdef",
  WECOM_CUSTOMER_SERVICE_URL: "https://work.weixin.qq.com/kfid/kfc_test_12345",
  SAFETY_CONTACT_MODE: "wecom",
};
describe("WeCom customer service is not an emergency acknowledgement", () => {
  it("defaults to unavailable and does not publish incomplete identifiers", () => {
    expect(customerServiceConfig(validateEnv({})).customerService).toEqual({
      provider: "none",
      available: false,
      url: "",
      corpId: "",
    });
    expect(
      customerServiceConfig(validateEnv({ ...settings, WECOM_CORP_ID: "" }))
        .customerService.available,
    ).toBe(false);
  });
  it("separates contact availability from confirmed safety staffing", () => {
    const result = customerServiceConfig(validateEnv(settings));
    expect(result.customerService.available).toBe(true);
    expect(result.safetyContact).toEqual({
      mode: "wecom",
      available: false,
      dutyConfirmed: false,
    });
    expect(
      customerServiceConfig(
        validateEnv({ ...settings, SAFETY_DUTY_CONFIRMED: "true" }),
      ).safetyContact.available,
    ).toBe(true);
  });
  it.each([
    "http://work.weixin.qq.com/kfid/kfc_test",
    "https://work.weixin.qq.com.evil.test/kfid/kfc_test",
    "https://evil.test/kfid/kfc_test",
    "https://work.weixin.qq.com@evil.test/kfid/kfc_test",
    "https://work.weixin.qq.com/kfid/kfc_test#fragment",
    "https://work.weixin.qq.com/kfid/kfc_test?access_token=secret",
    "https://work.weixin.qq.com:444/kfid/kfc_test",
    "https://work.weixin.qq.com/kfid/kfc_test?enc_scene=test&redirect=https://evil.test",
  ])("rejects unexpected external target %s", (url) => {
    expect(WecomCustomerServiceUrlSchema.safeParse(url).success).toBe(false);
    expect(
      customerServiceConfig(
        validateEnv({ ...settings, WECOM_CUSTOMER_SERVICE_URL: url }),
      ).customerService.url,
    ).toBe("");
  });
  it("allows official generated contact paths and an encoded scene without exposing API tokens", () => {
    expect(
      WecomCustomerServiceUrlSchema.safeParse(
        "https://work.weixin.qq.com/kf/kfc_test123?enc_scene=a%2Bb",
      ).success,
    ).toBe(true);
  });
  it("requires real WeCom identifiers and duty confirmation when replacing the phone gate", () => {
    expect(() =>
      validateEnv({ NODE_ENV: "production", SAFETY_CONTACT_MODE: "wecom" }),
    ).toThrow("WECOM_CORP_ID");
    expect(() => validateEnv({ NODE_ENV: "production", ...settings })).toThrow(
      "SAFETY_DUTY_CONFIRMED",
    );
    expect(() =>
      validateEnv({
        NODE_ENV: "production",
        ...settings,
        SAFETY_DUTY_CONFIRMED: "true",
      }),
    ).not.toThrow(/SAFETY_HOTLINE/);
  });
});
