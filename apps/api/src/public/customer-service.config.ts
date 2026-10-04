import {
  WecomCorpIdSchema,
  WecomCustomerServiceUrlSchema,
} from "@zydj/contracts";
import type { AppEnv } from "../config/env.js";

export function customerServiceConfig(
  env: Pick<
    AppEnv,
    | "CUSTOMER_SERVICE_PROVIDER"
    | "WECOM_CORP_ID"
    | "WECOM_CUSTOMER_SERVICE_URL"
    | "SAFETY_CONTACT_MODE"
    | "SAFETY_DUTY_CONFIRMED"
    | "SAFETY_HOTLINE"
    | "SAFETY_EMERGENCY_PHONE"
  >,
) {
  const ready =
    env.CUSTOMER_SERVICE_PROVIDER === "wecom" &&
    WecomCorpIdSchema.safeParse(env.WECOM_CORP_ID).success &&
    WecomCustomerServiceUrlSchema.safeParse(env.WECOM_CUSTOMER_SERVICE_URL)
      .success;
  return {
    emergencyContact: {
      phone: /^1[3-9]\d{9}$/.test(env.SAFETY_EMERGENCY_PHONE)
        ? env.SAFETY_EMERGENCY_PHONE
        : "",
      configured: /^1[3-9]\d{9}$/.test(env.SAFETY_EMERGENCY_PHONE),
    },
    customerService: {
      provider: env.CUSTOMER_SERVICE_PROVIDER,
      available: ready,
      url: ready ? env.WECOM_CUSTOMER_SERVICE_URL : "",
      corpId: ready ? env.WECOM_CORP_ID : "",
    },
    // Configuration confirmation is NOT a claim that a chat is currently staffed or acknowledged.
    safetyContact: {
      mode: env.SAFETY_CONTACT_MODE,
      available:
        env.SAFETY_CONTACT_MODE === "wecom"
          ? ready && env.SAFETY_DUTY_CONFIRMED === "true"
          : Boolean(env.SAFETY_HOTLINE),
      dutyConfirmed: env.SAFETY_DUTY_CONFIRMED === "true",
    },
  };
}
