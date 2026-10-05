import { describe, expect, it } from "vitest";
import { validateEnv } from "./env.js";

const productionAuth = {
  AUTH_PROVIDER: "wechat",
  WECHAT_MINIAPP_SECRET: "wechat-miniapp-secret-placeholder",
  AUTH_SESSION_PEPPER: "production-session-pepper-placeholder-32",
  DATA_ENCRYPTION_KEY_BASE64: "MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI=",
  WECHAT_PAY_NOTIFY_URL: "https://api.example.com/v1/payments/wechat/notify",
  ALIYUN_SMS_ACCESS_KEY_ID: "test-sms-access-key-id",
  ALIYUN_SMS_ACCESS_KEY_SECRET: "test-sms-access-key-secret",
  ALIYUN_SMS_SIGN_NAME: "测试签名",
  ALIYUN_SMS_TEMPLATE_CODE: "SMS_testtemplate",
  TENCENT_MAP_KEY: "test-map-key",
  TENCENT_MAP_SIGNING_SECRET: "test-map-signing-secret",
} as const;

describe("production safety gate", () => {
  it("allows approved WeCom duty contact with a separate emergency phone instead of a legacy hotline", () => {
    const raw = {
      NODE_ENV: "production",
      ...productionAuth,
      PAYMENT_PROVIDER: "wechat",
      WECHAT_MCH_ID: "test-merchant",
      WECHAT_PAY_API_V3_KEY: "12345678901234567890123456789012",
      WECHAT_PAY_MERCHANT_SERIAL_NO: "test-serial",
      WECHAT_PAY_PRIVATE_KEY_PATH: "/secure/test-private.pem",
      WECHAT_PAY_PUBLIC_KEY_ID: "PUB_KEY_ID_test",
      WECHAT_PAY_PUBLIC_KEY_PATH: "/secure/test-public.pem",
      SMS_PROVIDER: "aliyun",
      MAP_PROVIDER: "tencent",
      SAFETY_CONTACT_MODE: "wecom",
      CUSTOMER_SERVICE_PROVIDER: "wecom",
      WECOM_CORP_ID: "ww1234567890abcdef",
      WECOM_CUSTOMER_SERVICE_URL:
        "https://work.weixin.qq.com/kfid/kfc_test_12345",
      WECOM_CUSTOMER_SERVICE_CONFIRMED: "true",
      SAFETY_DUTY_CONFIRMED: "true",
      SAFETY_EMERGENCY_PHONE: "13800138000",
    };
    expect(validateEnv(raw).SAFETY_HOTLINE).toBe("");
    expect(() =>
      validateEnv({ ...raw, WECOM_CUSTOMER_SERVICE_CONFIRMED: "false" }),
    ).toThrow("WECOM_CUSTOMER_SERVICE_CONFIRMED");
    expect(() =>
      validateEnv({ ...raw, SAFETY_DUTY_CONFIRMED: "false" }),
    ).toThrow("SAFETY_DUTY_CONFIRMED");
    expect(() => validateEnv({ ...raw, SAFETY_EMERGENCY_PHONE: "" })).toThrow(
      "SAFETY_EMERGENCY_PHONE",
    );
    expect(() =>
      validateEnv({
        ...raw,
        WECOM_CUSTOMER_SERVICE_URL: "https://evil.test/kfid/test123",
      }),
    ).toThrow("WECOM_CUSTOMER_SERVICE_URL");
  });
  it("keeps chargeable integration calls independently disabled", () => {
    const env = validateEnv({
      SMS_PROVIDER: "aliyun",
      MAP_PROVIDER: "tencent",
    });
    expect(env.SMS_SEND_ENABLED).toBe("false");
    expect(env.SAFETY_NOTIFICATION_DISPATCH_ENABLED).toBe("false");
    expect(env.SAFETY_NOTIFICATION_RECEIPT_QUERY_ENABLED).toBe("false");
    expect(env.MAP_GEOCODING_ENABLED).toBe("false");
    expect(env.SERVICE_CITY).toBe("郑州市");
    expect(() => validateEnv({ SMS_SEND_ENABLED: "yes" })).toThrow();
    expect(() => validateEnv({ MAP_GEOCODING_ENABLED: "yes" })).toThrow();
    expect(() =>
      validateEnv({
        MAP_PROVIDER: "tencent",
        MAP_GEOCODING_ENABLED: "true",
        TENCENT_MAP_KEY: "test-map-key",
        TENCENT_MAP_SIGNING_SECRET: "test-map-secret",
      }),
    ).toThrow("SERVICE_AREA_ADCODE_ALLOWLIST");
    expect(
      validateEnv({
        MAP_PROVIDER: "tencent",
        MAP_GEOCODING_ENABLED: "true",
        TENCENT_MAP_KEY: "test-map-key",
        TENCENT_MAP_SIGNING_SECRET: "test-map-secret",
        SERVICE_AREA_ADCODE_ALLOWLIST: "410102,410105",
      }).SERVICE_AREA_ADCODE_ALLOWLIST,
    ).toBe("410102,410105");
    expect(() =>
      validateEnv({ SERVICE_AREA_ADCODE_ALLOWLIST: "410102,410102" }),
    ).toThrow("无重复");
    expect(() =>
      validateEnv({ SAFETY_NOTIFICATION_DISPATCH_ENABLED: "yes" }),
    ).toThrow();
    expect(() =>
      validateEnv({ SAFETY_NOTIFICATION_RECEIPT_QUERY_ENABLED: "yes" }),
    ).toThrow();
  });
  it("allows read-only receipt queries only with the Aliyun provider in production", () => {
    const raw = {
      NODE_ENV: "production",
      ...productionAuth,
      PAYMENT_PROVIDER: "wechat",
      WECHAT_MCH_ID: "test-merchant",
      WECHAT_PAY_API_V3_KEY: "12345678901234567890123456789012",
      WECHAT_PAY_MERCHANT_SERIAL_NO: "test-serial",
      WECHAT_PAY_PRIVATE_KEY_PATH: "/secure/test-private.pem",
      WECHAT_PAY_PUBLIC_KEY_ID: "PUB_KEY_ID_test",
      WECHAT_PAY_PUBLIC_KEY_PATH: "/secure/test-public.pem",
      MAP_PROVIDER: "tencent",
      SAFETY_HOTLINE: "400-000-0000",
      SAFETY_NOTIFICATION_RECEIPT_QUERY_ENABLED: "true",
    };
    expect(() => validateEnv({ ...raw, SMS_PROVIDER: "mock" })).toThrow(
      "SMS_PROVIDER",
    );
    expect(
      validateEnv({ ...raw, SMS_PROVIDER: "aliyun" })
        .SAFETY_NOTIFICATION_RECEIPT_QUERY_ENABLED,
    ).toBe("true");
  });
  it("requires an explicit send gate and confirmed duty before automated safety dispatch", () => {
    const raw = {
      NODE_ENV: "production",
      ...productionAuth,
      PAYMENT_PROVIDER: "wechat",
      WECHAT_MCH_ID: "test-merchant",
      WECHAT_PAY_API_V3_KEY: "12345678901234567890123456789012",
      WECHAT_PAY_MERCHANT_SERIAL_NO: "test-serial",
      WECHAT_PAY_PRIVATE_KEY_PATH: "/secure/test-private.pem",
      WECHAT_PAY_PUBLIC_KEY_ID: "PUB_KEY_ID_test",
      WECHAT_PAY_PUBLIC_KEY_PATH: "/secure/test-public.pem",
      SMS_PROVIDER: "aliyun",
      MAP_PROVIDER: "tencent",
      SAFETY_HOTLINE: "400-000-0000",
      SAFETY_NOTIFICATION_DISPATCH_ENABLED: "true",
    };
    expect(() => validateEnv(raw)).toThrow("SMS_SEND_ENABLED");
    expect(() => validateEnv({ ...raw, SMS_SEND_ENABLED: "true" })).toThrow(
      "SAFETY_DUTY_CONFIRMED",
    );
    expect(
      validateEnv({
        ...raw,
        SMS_SEND_ENABLED: "true",
        SAFETY_DUTY_CONFIRMED: "true",
      }).SAFETY_NOTIFICATION_DISPATCH_ENABLED,
    ).toBe("true");
  });
  it("rejects provider label substitution without SMS/map credentials in production", () => {
    const raw = {
      NODE_ENV: "production",
      SMS_PROVIDER: "aliyun",
      MAP_PROVIDER: "tencent",
    };
    for (const field of [
      "ALIYUN_SMS_ACCESS_KEY_ID",
      "ALIYUN_SMS_ACCESS_KEY_SECRET",
      "ALIYUN_SMS_SIGN_NAME",
      "ALIYUN_SMS_TEMPLATE_CODE",
      "TENCENT_MAP_KEY",
      "TENCENT_MAP_SIGNING_SECRET",
    ])
      expect(() => validateEnv(raw)).toThrow(field);
  });
  it("keeps original-order recovery independently opt-in", () => {
    expect(
      validateEnv({
        PAYMENT_PROVIDER: "wechat",
        WECHAT_PAY_PREPAY_ENABLED: "true",
      }).WECHAT_PAY_RECOVERY_ENABLED,
    ).toBe("false");
    expect(() => validateEnv({ WECHAT_PAY_RECOVERY_ENABLED: "yes" })).toThrow();
  });
  it("keeps the prepay gate opt-in independently of provider selection", () => {
    expect(
      validateEnv({ PAYMENT_PROVIDER: "wechat" }).WECHAT_PAY_PREPAY_ENABLED,
    ).toBe("false");
    expect(() => validateEnv({ WECHAT_PAY_PREPAY_ENABLED: "yes" })).toThrow();
  });
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
