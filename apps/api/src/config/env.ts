import { z } from "zod";
import {
  WecomCorpIdSchema,
  WecomCustomerServiceUrlSchema,
} from "@zydj/contracts";

const EnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  API_PORT: z.coerce.number().int().positive().default(3100),
  API_HOST: z.string().default("127.0.0.1"),
  CORS_ORIGINS: z
    .string()
    .default(
      "http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174",
    ),
  BRAND_NAME: z.string().default("中原到家"),
  SERVICE_CITY: z.string().trim().min(2).max(32).default("郑州市"),
  WECHAT_MINIAPP_APP_ID: z.string().default("wxab76ea213eb6d01a"),
  WECHAT_MINIAPP_SECRET: z.string().default(""),
  WECHAT_OFFICIAL_ACCOUNT_ID: z.string().default("gh_a4b5f9d63539"),
  AUTH_PROVIDER: z.enum(["mock", "wechat"]).default("mock"),
  // Production always requires staff MFA; this flag also exercises it in private tests.
  STAFF_MFA_REQUIRED: z.enum(["false", "true"]).default("false"),
  STAFF_BROWSER_LOGIN_ENABLED: z.enum(["false", "true"]).default("false"),
  AUTH_SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .max(2_592_000)
    .default(604_800),
  AUTH_SESSION_PEPPER: z
    .string()
    .default("local-only-session-pepper-change-before-production"),
  DATA_ENCRYPTION_KEY_BASE64: z
    .string()
    .default("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
  PAYMENT_PROVIDER: z.enum(["mock", "wechat"]).default("mock"),
  WECHAT_MCH_ID: z.string().default(""),
  WECHAT_PAY_API_V3_KEY: z.string().default(""),
  WECHAT_PAY_MERCHANT_SERIAL_NO: z.string().default(""),
  WECHAT_PAY_PRIVATE_KEY_PATH: z.string().default(""),
  WECHAT_PAY_MERCHANT_CERT_PATH: z.string().default(""),
  WECHAT_PAY_PUBLIC_KEY_ID: z.string().default(""),
  WECHAT_PAY_PUBLIC_KEY_PATH: z.string().default(""),
  WECHAT_PAY_PLATFORM_CERT_PATH: z.string().default(""),
  WECHAT_PAY_NOTIFY_URL: z.string().default(""),
  // Separate opt-in: credentials/provider selection never authorize a payment POST.
  WECHAT_PAY_PREPAY_ENABLED: z.enum(["false", "true"]).default("false"),
  // Independent opt-in for automatic original-order query/close compensation.
  WECHAT_PAY_RECOVERY_ENABLED: z.enum(["false", "true"]).default("false"),
  // Opt-in only after two-person finance review and controlled merchant acceptance.
  WECHAT_PAY_REFUND_ENABLED: z.enum(["false", "true"]).default("false"),
  WECHAT_PAY_REFUND_NOTIFY_URL: z.string().default(""),
  SMS_PROVIDER: z.enum(["none", "mock", "aliyun"]).default("mock"),
  MAP_PROVIDER: z.enum(["mock", "amap"]).default("mock"),
  SMS_SEND_ENABLED: z.enum(["false", "true"]).default("false"),
  // Separate dispatch gate: channel credentials and provider selection do not authorize automated safety sends.
  SAFETY_NOTIFICATION_DISPATCH_ENABLED: z
    .enum(["false", "true"])
    .default("false"),
  // Read-only provider delivery queries are separately enabled from sending.
  SAFETY_NOTIFICATION_RECEIPT_QUERY_ENABLED: z
    .enum(["false", "true"])
    .default("false"),
  ALIYUN_SMS_ACCESS_KEY_ID: z.string().default(""),
  ALIYUN_SMS_ACCESS_KEY_SECRET: z.string().default(""),
  ALIYUN_SMS_SECURITY_TOKEN: z.string().default(""),
  ALIYUN_SMS_SIGN_NAME: z.string().default(""),
  ALIYUN_SMS_TEMPLATE_CODE: z.string().default(""),
  MAP_GEOCODING_ENABLED: z.enum(["false", "true"]).default("false"),
  SERVICE_AREA_ADCODE_ALLOWLIST: z.string().default(""),
  AMAP_MINIAPP_KEY: z.string().default(""),
  AMAP_WEB_SERVICE_KEY: z.string().default(""),
  SAFETY_HOTLINE: z.string().default(""),
  SAFETY_EMERGENCY_PHONE: z.string().default(""),
  CUSTOMER_SERVICE_PROVIDER: z.enum(["none", "wecom"]).default("none"),
  WECOM_CORP_ID: z.string().default(""),
  WECOM_CUSTOMER_SERVICE_URL: z.string().default(""),
  // Manual ownership/account/miniapp-binding verification, not an online status or emergency acknowledgement.
  WECOM_CUSTOMER_SERVICE_CONFIRMED: z.enum(["false", "true"]).default("false"),
  SAFETY_CONTACT_MODE: z.enum(["phone", "wecom"]).default("phone"),
  SAFETY_DUTY_CONFIRMED: z.enum(["false", "true"]).default("false"),
  // Existing server aliases. They are normalized to the canonical names above.
  WECHAT_APPID: z.string().default(""),
  WECHAT_APP_SECRET: z.string().default(""),
  WECHAT_MCHID: z.string().default(""),
  WECHAT_API_V3_KEY: z.string().default(""),
  WECHAT_MCH_SERIAL_NO: z.string().default(""),
  WECHAT_PRIVATE_KEY_PATH: z.string().default(""),
  WECHAT_PLATFORM_SERIAL_NO: z.string().default(""),
  WECHAT_PLATFORM_CERT_PATH: z.string().default(""),
});

export type AppEnv = z.infer<typeof EnvSchema>;

export const validateEnv = (raw: Record<string, unknown>): AppEnv => {
  const parsed = EnvSchema.parse(raw);
  const hasCanonicalMiniappAppId =
    typeof raw.WECHAT_MINIAPP_APP_ID === "string" &&
    raw.WECHAT_MINIAPP_APP_ID.length > 0;
  const hasCanonicalMiniappSecret =
    typeof raw.WECHAT_MINIAPP_SECRET === "string" &&
    raw.WECHAT_MINIAPP_SECRET.length > 0;

  const canonicalMerchantValues = [
    parsed.WECHAT_MCH_ID,
    parsed.WECHAT_PAY_API_V3_KEY,
    parsed.WECHAT_PAY_MERCHANT_SERIAL_NO,
    parsed.WECHAT_PAY_PRIVATE_KEY_PATH,
  ];
  const legacyMerchantValues = [
    parsed.WECHAT_MCHID,
    parsed.WECHAT_API_V3_KEY,
    parsed.WECHAT_MCH_SERIAL_NO,
    parsed.WECHAT_PRIVATE_KEY_PATH,
  ];
  const hasCanonicalMerchantConfig = canonicalMerchantValues.some(Boolean);
  const hasLegacyMerchantConfig = legacyMerchantValues.some(Boolean);

  const hasCanonicalPublicKeyConfig = Boolean(
    parsed.WECHAT_PAY_PUBLIC_KEY_ID || parsed.WECHAT_PAY_PUBLIC_KEY_PATH,
  );
  const hasCanonicalPlatformCertificate = Boolean(
    parsed.WECHAT_PAY_PLATFORM_CERT_PATH,
  );
  const hasCanonicalPlatformConfig =
    hasCanonicalPublicKeyConfig || hasCanonicalPlatformCertificate;
  const hasLegacyPlatformConfig = Boolean(
    parsed.WECHAT_PLATFORM_SERIAL_NO || parsed.WECHAT_PLATFORM_CERT_PATH,
  );
  const legacyUsesPublicKey =
    parsed.WECHAT_PLATFORM_SERIAL_NO.startsWith("PUB_KEY_ID_");

  const env: AppEnv = {
    ...parsed,
    WECHAT_MINIAPP_APP_ID: hasCanonicalMiniappAppId
      ? parsed.WECHAT_MINIAPP_APP_ID
      : parsed.WECHAT_APPID || parsed.WECHAT_MINIAPP_APP_ID,
    WECHAT_MINIAPP_SECRET: hasCanonicalMiniappSecret
      ? parsed.WECHAT_MINIAPP_SECRET
      : parsed.WECHAT_APP_SECRET,
    WECHAT_MCH_ID: hasCanonicalMerchantConfig
      ? parsed.WECHAT_MCH_ID
      : parsed.WECHAT_MCHID,
    WECHAT_PAY_API_V3_KEY: hasCanonicalMerchantConfig
      ? parsed.WECHAT_PAY_API_V3_KEY
      : parsed.WECHAT_API_V3_KEY,
    WECHAT_PAY_MERCHANT_SERIAL_NO: hasCanonicalMerchantConfig
      ? parsed.WECHAT_PAY_MERCHANT_SERIAL_NO
      : parsed.WECHAT_MCH_SERIAL_NO,
    WECHAT_PAY_PRIVATE_KEY_PATH: hasCanonicalMerchantConfig
      ? parsed.WECHAT_PAY_PRIVATE_KEY_PATH
      : parsed.WECHAT_PRIVATE_KEY_PATH,
    WECHAT_PAY_PUBLIC_KEY_ID: hasCanonicalPlatformConfig
      ? parsed.WECHAT_PAY_PUBLIC_KEY_ID
      : legacyUsesPublicKey
        ? parsed.WECHAT_PLATFORM_SERIAL_NO
        : "",
    WECHAT_PAY_PUBLIC_KEY_PATH: hasCanonicalPlatformConfig
      ? parsed.WECHAT_PAY_PUBLIC_KEY_PATH
      : legacyUsesPublicKey
        ? parsed.WECHAT_PLATFORM_CERT_PATH
        : "",
    WECHAT_PAY_PLATFORM_CERT_PATH: hasCanonicalPlatformConfig
      ? parsed.WECHAT_PAY_PLATFORM_CERT_PATH
      : hasLegacyPlatformConfig && !legacyUsesPublicKey
        ? parsed.WECHAT_PLATFORM_CERT_PATH
        : "",
  };

  const serviceAreaAdcodes = env.SERVICE_AREA_ADCODE_ALLOWLIST.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    serviceAreaAdcodes.some((value) => !/^\d{6}$/.test(value)) ||
    new Set(serviceAreaAdcodes).size !== serviceAreaAdcodes.length
  )
    throw new Error(
      "SERVICE_AREA_ADCODE_ALLOWLIST 必须是无重复的六位行政区代码",
    );
  if (env.MAP_GEOCODING_ENABLED === "true") {
    const invalid: string[] = [];
    if (env.MAP_PROVIDER !== "amap") invalid.push("MAP_PROVIDER");
    for (const key of ["AMAP_MINIAPP_KEY", "AMAP_WEB_SERVICE_KEY"] as const) {
      if (!/^[A-Fa-f0-9]{32}$/.test(env[key])) invalid.push(key);
    }
    if (!serviceAreaAdcodes.length)
      invalid.push("SERVICE_AREA_ADCODE_ALLOWLIST");
    if (invalid.length)
      throw new Error(`地图核验门禁未通过: ${invalid.join(", ")}`);
  }

  if (env.NODE_ENV === "production") {
    const invalid: string[] = [];
    if (env.AUTH_PROVIDER === "mock") invalid.push("AUTH_PROVIDER");
    if (env.AUTH_PROVIDER === "wechat" && !env.WECHAT_MINIAPP_SECRET) {
      invalid.push("WECHAT_MINIAPP_SECRET");
    }
    if (
      env.AUTH_SESSION_PEPPER.length < 32 ||
      env.AUTH_SESSION_PEPPER.startsWith("local-only-")
    ) {
      invalid.push("AUTH_SESSION_PEPPER");
    }
    let encryptionKeyLength = 0;
    try {
      encryptionKeyLength = Buffer.from(
        env.DATA_ENCRYPTION_KEY_BASE64,
        "base64",
      ).length;
    } catch {
      encryptionKeyLength = 0;
    }
    if (
      encryptionKeyLength !== 32 ||
      env.DATA_ENCRYPTION_KEY_BASE64 ===
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    ) {
      invalid.push("DATA_ENCRYPTION_KEY_BASE64");
    }
    if (env.PAYMENT_PROVIDER === "mock") invalid.push("PAYMENT_PROVIDER");
    if (env.SMS_PROVIDER === "mock") invalid.push("SMS_PROVIDER");
    if (
      env.SMS_PROVIDER === "none" &&
      (env.SMS_SEND_ENABLED === "true" ||
        env.SAFETY_NOTIFICATION_DISPATCH_ENABLED === "true" ||
        env.SAFETY_NOTIFICATION_RECEIPT_QUERY_ENABLED === "true")
    )
      invalid.push("SMS_PROVIDER");
    if (env.MAP_PROVIDER === "mock") invalid.push("MAP_PROVIDER");
    if (env.SAFETY_CONTACT_MODE === "phone" && !env.SAFETY_HOTLINE)
      invalid.push("SAFETY_HOTLINE");
    if (
      env.CUSTOMER_SERVICE_PROVIDER === "wecom" ||
      env.SAFETY_CONTACT_MODE === "wecom"
    ) {
      if (env.CUSTOMER_SERVICE_PROVIDER !== "wecom")
        invalid.push("CUSTOMER_SERVICE_PROVIDER");
      if (!WecomCorpIdSchema.safeParse(env.WECOM_CORP_ID).success)
        invalid.push("WECOM_CORP_ID");
      if (
        !WecomCustomerServiceUrlSchema.safeParse(env.WECOM_CUSTOMER_SERVICE_URL)
          .success
      )
        invalid.push("WECOM_CUSTOMER_SERVICE_URL");
      if (env.WECOM_CUSTOMER_SERVICE_CONFIRMED !== "true")
        invalid.push("WECOM_CUSTOMER_SERVICE_CONFIRMED");
      if (
        env.SAFETY_CONTACT_MODE === "wecom" &&
        env.SAFETY_DUTY_CONFIRMED !== "true"
      )
        invalid.push("SAFETY_DUTY_CONFIRMED");
      if (
        env.SAFETY_CONTACT_MODE === "wecom" &&
        !/^1[3-9]\d{9}$/.test(env.SAFETY_EMERGENCY_PHONE)
      )
        invalid.push("SAFETY_EMERGENCY_PHONE");
    }
    if (env.SMS_PROVIDER === "aliyun") {
      for (const key of [
        "ALIYUN_SMS_ACCESS_KEY_ID",
        "ALIYUN_SMS_ACCESS_KEY_SECRET",
        "ALIYUN_SMS_SIGN_NAME",
      ] as const) {
        if (!env[key].trim() || /[\r\n]/.test(env[key])) invalid.push(key);
      }
      if (!/^SMS_[A-Za-z0-9]+$/.test(env.ALIYUN_SMS_TEMPLATE_CODE))
        invalid.push("ALIYUN_SMS_TEMPLATE_CODE");
    }
    if (env.SAFETY_NOTIFICATION_DISPATCH_ENABLED === "true") {
      if (env.SMS_PROVIDER !== "aliyun") invalid.push("SMS_PROVIDER");
      if (env.SMS_SEND_ENABLED !== "true") invalid.push("SMS_SEND_ENABLED");
      if (env.SAFETY_DUTY_CONFIRMED !== "true")
        invalid.push("SAFETY_DUTY_CONFIRMED");
    }
    if (
      env.SAFETY_NOTIFICATION_RECEIPT_QUERY_ENABLED === "true" &&
      env.SMS_PROVIDER !== "aliyun"
    )
      invalid.push("SMS_PROVIDER");
    if (env.MAP_PROVIDER === "amap") {
      for (const key of ["AMAP_MINIAPP_KEY", "AMAP_WEB_SERVICE_KEY"] as const) {
        if (!/^[A-Fa-f0-9]{32}$/.test(env[key])) invalid.push(key);
      }
    }

    if (env.PAYMENT_PROVIDER === "wechat") {
      if (
        env.WECHAT_PAY_REFUND_ENABLED === "true" &&
        !/^https:\/\//.test(env.WECHAT_PAY_REFUND_NOTIFY_URL)
      )
        invalid.push("WECHAT_PAY_REFUND_NOTIFY_URL");
      if (hasCanonicalMerchantConfig && hasLegacyMerchantConfig) {
        invalid.push("新旧微信支付商户配置不能混用");
      }
      if (!env.WECHAT_MCH_ID) invalid.push("WECHAT_MCH_ID");
      if (env.WECHAT_PAY_API_V3_KEY.length !== 32)
        invalid.push("WECHAT_PAY_API_V3_KEY");
      if (!env.WECHAT_PAY_MERCHANT_SERIAL_NO)
        invalid.push("WECHAT_PAY_MERCHANT_SERIAL_NO");
      if (!env.WECHAT_PAY_PRIVATE_KEY_PATH)
        invalid.push("WECHAT_PAY_PRIVATE_KEY_PATH");
      if (!/^https:\/\//.test(env.WECHAT_PAY_NOTIFY_URL))
        invalid.push("WECHAT_PAY_NOTIFY_URL");

      if (
        hasCanonicalMiniappAppId &&
        parsed.WECHAT_APPID &&
        parsed.WECHAT_MINIAPP_APP_ID !== parsed.WECHAT_APPID
      ) {
        invalid.push("WECHAT_MINIAPP_APP_ID 与 WECHAT_APPID 冲突");
      }
      if (
        hasCanonicalMiniappSecret &&
        parsed.WECHAT_APP_SECRET &&
        parsed.WECHAT_MINIAPP_SECRET !== parsed.WECHAT_APP_SECRET
      ) {
        invalid.push("WECHAT_MINIAPP_SECRET 与 WECHAT_APP_SECRET 冲突");
      }

      if (hasCanonicalPlatformConfig && hasLegacyPlatformConfig) {
        invalid.push("新旧微信支付平台验签配置不能混用");
      }
      if (
        hasCanonicalPublicKeyConfig &&
        (!env.WECHAT_PAY_PUBLIC_KEY_ID || !env.WECHAT_PAY_PUBLIC_KEY_PATH)
      ) {
        invalid.push(
          "WECHAT_PAY_PUBLIC_KEY_ID 与 WECHAT_PAY_PUBLIC_KEY_PATH 必须成对配置",
        );
      }
      if (hasCanonicalPublicKeyConfig && hasCanonicalPlatformCertificate) {
        invalid.push("平台公钥模式与平台证书模式只能选择一种");
      }
      if (
        hasLegacyPlatformConfig &&
        (!parsed.WECHAT_PLATFORM_SERIAL_NO || !parsed.WECHAT_PLATFORM_CERT_PATH)
      ) {
        invalid.push(
          "WECHAT_PLATFORM_SERIAL_NO 与 WECHAT_PLATFORM_CERT_PATH 必须成对配置",
        );
      }

      const hasPublicKey = Boolean(
        env.WECHAT_PAY_PUBLIC_KEY_ID.startsWith("PUB_KEY_ID_") &&
          env.WECHAT_PAY_PUBLIC_KEY_PATH,
      );
      const hasPlatformCertificate = Boolean(env.WECHAT_PAY_PLATFORM_CERT_PATH);
      if (!hasPublicKey && !hasPlatformCertificate) {
        invalid.push(
          "WECHAT_PAY_PUBLIC_KEY_ID + WECHAT_PAY_PUBLIC_KEY_PATH 或 WECHAT_PAY_PLATFORM_CERT_PATH",
        );
      }
    }

    if (invalid.length) {
      throw new Error(`生产配置未通过安全门禁: ${invalid.join(", ")}`);
    }
  }
  return env;
};
