import { describe, expect, it } from "vitest";
import { validateEnv } from "./env.js";

const productionAuth = {
  AUTH_PROVIDER: "wechat",
  WECHAT_MINIAPP_SECRET: "wechat-miniapp-secret-placeholder",
  AUTH_SESSION_PEPPER: "production-session-pepper-placeholder-32",
  DATA_ENCRYPTION_KEY_BASE64: "MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI=",
  WECHAT_PAY_NOTIFY_URL: "https://api.example.com/v1/payments/wechat/notify",
} as const;

describe("production safety gate", () => {
  it("defaults real refund submission to closed and requires an HTTPS callback when enabled", () => {
    expect(
      validateEnv({ NODE_ENV: "development" }).WECHAT_PAY_REFUND_ENABLED,
    ).toBe("false");
    expect(() =>
      validateEnv({
        NODE_ENV: "production",
        PAYMENT_PROVIDER: "wechat",
        WECHAT_PAY_REFUND_ENABLED: "true",
      }),
    ).toThrow("WECHAT_PAY_REFUND_NOTIFY_URL");
    expect(() => validateEnv({ WECHAT_PAY_REFUND_ENABLED: "yes" })).toThrow();
  });
  it("rejects mock integrations in production", () => {
    expect(() => validateEnv({ NODE_ENV: "production" })).toThrow(
      "生产配置未通过安全门禁",
    );
  });

  it("allows explicit development mode", () => {
    const env = validateEnv({ NODE_ENV: "development" });
    expect(env.PAYMENT_PROVIDER).toBe("mock");
    expect(env.CORS_ORIGINS).toContain("http://127.0.0.1:5173");
  });

  it("rejects missing WeChat Pay merchant and signature verification configuration", () => {
    const validate = () =>
      validateEnv({
        NODE_ENV: "production",
        PAYMENT_PROVIDER: "wechat",
        SMS_PROVIDER: "aliyun",
        MAP_PROVIDER: "tencent",
        SAFETY_HOTLINE: "400-000-0000",
      });

    expect(validate).toThrow("WECHAT_MCH_ID");
    expect(validate).toThrow("WECHAT_PAY_API_V3_KEY");
    expect(validate).toThrow("WECHAT_PAY_MERCHANT_SERIAL_NO");
    expect(validate).toThrow("WECHAT_PAY_PRIVATE_KEY_PATH");
    expect(validate).toThrow("WECHAT_PAY_NOTIFY_URL");
    expect(validate).toThrow(
      "WECHAT_PAY_PUBLIC_KEY_ID + WECHAT_PAY_PUBLIC_KEY_PATH",
    );
  });

  it("allows WeChat Pay public key verification mode in production", () => {
    const env = validateEnv({
      NODE_ENV: "production",
      ...productionAuth,
      PAYMENT_PROVIDER: "wechat",
      WECHAT_MCH_ID: "merchant-id-placeholder",
      WECHAT_PAY_API_V3_KEY: "12345678901234567890123456789012",
      WECHAT_PAY_MERCHANT_SERIAL_NO: "serial-placeholder",
      WECHAT_PAY_PRIVATE_KEY_PATH: "/secure/wechat/merchant-private-key.pem",
      WECHAT_PAY_PUBLIC_KEY_ID: "PUB_KEY_ID_placeholder",
      WECHAT_PAY_PUBLIC_KEY_PATH: "/secure/wechat/wechat-pay-public-key.pem",
      SMS_PROVIDER: "aliyun",
      MAP_PROVIDER: "tencent",
      SAFETY_HOTLINE: "400-000-0000",
    });

    expect(env.PAYMENT_PROVIDER).toBe("wechat");
    expect(env.WECHAT_PAY_PLATFORM_CERT_PATH).toBe("");
  });

  it("normalizes the existing server public-key-mode aliases", () => {
    const env = validateEnv({
      NODE_ENV: "production",
      ...productionAuth,
      WECHAT_MINIAPP_SECRET: "",
      PAYMENT_PROVIDER: "wechat",
      WECHAT_APPID: "wxlegacy-alias-placeholder",
      WECHAT_APP_SECRET: "legacy-secret-placeholder",
      WECHAT_MCHID: "merchant-id-placeholder",
      WECHAT_API_V3_KEY: "12345678901234567890123456789012",
      WECHAT_MCH_SERIAL_NO: "serial-placeholder",
      WECHAT_PRIVATE_KEY_PATH: "/secure/wechat/merchant-private-key.pem",
      WECHAT_PLATFORM_SERIAL_NO: "PUB_KEY_ID_existing-server",
      WECHAT_PLATFORM_CERT_PATH: "/secure/wechat/wechat-pay-public-key.pem",
      SMS_PROVIDER: "aliyun",
      MAP_PROVIDER: "tencent",
      SAFETY_HOTLINE: "400-000-0000",
    });

    expect(env.WECHAT_MINIAPP_APP_ID).toBe("wxlegacy-alias-placeholder");
    expect(env.WECHAT_MINIAPP_SECRET).toBe("legacy-secret-placeholder");
    expect(env.WECHAT_MCH_ID).toBe("merchant-id-placeholder");
    expect(env.WECHAT_PAY_PUBLIC_KEY_ID).toBe("PUB_KEY_ID_existing-server");
    expect(env.WECHAT_PAY_PUBLIC_KEY_PATH).toBe(
      "/secure/wechat/wechat-pay-public-key.pem",
    );
    expect(env.WECHAT_PAY_PLATFORM_CERT_PATH).toBe("");
  });

  it("rejects mixed canonical and legacy merchant credential groups", () => {
    const validate = () =>
      validateEnv({
        NODE_ENV: "production",
        ...productionAuth,
        PAYMENT_PROVIDER: "wechat",
        WECHAT_MCH_ID: "canonical-merchant",
        WECHAT_API_V3_KEY: "12345678901234567890123456789012",
        WECHAT_MCH_SERIAL_NO: "legacy-serial",
        WECHAT_PRIVATE_KEY_PATH: "/secure/wechat/legacy-private-key.pem",
        WECHAT_PLATFORM_SERIAL_NO: "PUB_KEY_ID_existing-server",
        WECHAT_PLATFORM_CERT_PATH: "/secure/wechat/wechat-pay-public-key.pem",
        SMS_PROVIDER: "aliyun",
        MAP_PROVIDER: "tencent",
        SAFETY_HOTLINE: "400-000-0000",
      });

    expect(validate).toThrow("新旧微信支付商户配置不能混用");
  });

  it("rejects mixing public-key and platform-certificate verification modes", () => {
    const validate = () =>
      validateEnv({
        NODE_ENV: "production",
        ...productionAuth,
        PAYMENT_PROVIDER: "wechat",
        WECHAT_MCH_ID: "merchant-id-placeholder",
        WECHAT_PAY_API_V3_KEY: "12345678901234567890123456789012",
        WECHAT_PAY_MERCHANT_SERIAL_NO: "serial-placeholder",
        WECHAT_PAY_PRIVATE_KEY_PATH: "/secure/wechat/merchant-private-key.pem",
        WECHAT_PAY_PUBLIC_KEY_ID: "PUB_KEY_ID_placeholder",
        WECHAT_PAY_PUBLIC_KEY_PATH: "/secure/wechat/wechat-pay-public-key.pem",
        WECHAT_PAY_PLATFORM_CERT_PATH:
          "/secure/wechat/platform-certificate.pem",
        SMS_PROVIDER: "aliyun",
        MAP_PROVIDER: "tencent",
        SAFETY_HOTLINE: "400-000-0000",
      });

    expect(validate).toThrow("平台公钥模式与平台证书模式只能选择一种");
  });

  it("normalizes the legacy platform-certificate mode", () => {
    const env = validateEnv({
      NODE_ENV: "production",
      ...productionAuth,
      PAYMENT_PROVIDER: "wechat",
      WECHAT_MCHID: "merchant-id-placeholder",
      WECHAT_API_V3_KEY: "12345678901234567890123456789012",
      WECHAT_MCH_SERIAL_NO: "merchant-serial-placeholder",
      WECHAT_PRIVATE_KEY_PATH: "/secure/wechat/merchant-private-key.pem",
      WECHAT_PLATFORM_SERIAL_NO: "platform-certificate-serial",
      WECHAT_PLATFORM_CERT_PATH: "/secure/wechat/platform-certificate.pem",
      SMS_PROVIDER: "aliyun",
      MAP_PROVIDER: "tencent",
      SAFETY_HOTLINE: "400-000-0000",
    });

    expect(env.WECHAT_PAY_PUBLIC_KEY_ID).toBe("");
    expect(env.WECHAT_PAY_PUBLIC_KEY_PATH).toBe("");
    expect(env.WECHAT_PAY_PLATFORM_CERT_PATH).toBe(
      "/secure/wechat/platform-certificate.pem",
    );
  });
});
