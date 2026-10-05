import { Controller, Get } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AppEnv } from "../config/env.js";
import { customerServiceConfig } from "./customer-service.config.js";

@Controller()
export class PublicController {
  constructor(private readonly config: ConfigService<AppEnv, true>) {}

  @Get("health")
  health() {
    return {
      status: "ok",
      service: "zhongyuan-daojia-api",
      timestamp: new Date().toISOString(),
    };
  }

  @Get("config/public")
  publicConfig() {
    const nodeEnv = this.config.get("NODE_ENV", { infer: true });
    return {
      data: {
        brandName: this.config.get("BRAND_NAME", { infer: true }),
        miniappAppId: this.config.get("WECHAT_MINIAPP_APP_ID", { infer: true }),
        officialAccountId: this.config.get("WECHAT_OFFICIAL_ACCOUNT_ID", {
          infer: true,
        }),
        operatingMode: nodeEnv === "production" ? "PRODUCTION" : "DEVELOPMENT",
        serviceCity: this.config.get("SERVICE_CITY", { infer: true }),
        safetyHotlineAvailable: Boolean(
          this.config.get("SAFETY_HOTLINE", { infer: true }),
        ),
        ...customerServiceConfig({
          CUSTOMER_SERVICE_PROVIDER: this.config.get(
            "CUSTOMER_SERVICE_PROVIDER",
            { infer: true },
          ),
          WECOM_CORP_ID: this.config.get("WECOM_CORP_ID", { infer: true }),
          WECOM_CUSTOMER_SERVICE_URL: this.config.get(
            "WECOM_CUSTOMER_SERVICE_URL",
            { infer: true },
          ),
          WECOM_CUSTOMER_SERVICE_CONFIRMED: this.config.get(
            "WECOM_CUSTOMER_SERVICE_CONFIRMED",
            { infer: true },
          ),
          SAFETY_CONTACT_MODE: this.config.get("SAFETY_CONTACT_MODE", {
            infer: true,
          }),
          SAFETY_DUTY_CONFIRMED: this.config.get("SAFETY_DUTY_CONFIRMED", {
            infer: true,
          }),
          SAFETY_HOTLINE: this.config.get("SAFETY_HOTLINE", { infer: true }),
          SAFETY_EMERGENCY_PHONE: this.config.get("SAFETY_EMERGENCY_PHONE", {
            infer: true,
          }),
        }),
        integrations: {
          payment: this.config.get("PAYMENT_PROVIDER", { infer: true }),
          sms: this.config.get("SMS_PROVIDER", { infer: true }),
          map: this.config.get("MAP_PROVIDER", { infer: true }),
        },
        features: {
          addressSuggestionAvailable:
            this.config.get("MAP_PROVIDER", { infer: true }) === "tencent" &&
            this.config.get("MAP_GEOCODING_ENABLED", { infer: true }) ===
              "true",
        },
      },
    };
  }
}
