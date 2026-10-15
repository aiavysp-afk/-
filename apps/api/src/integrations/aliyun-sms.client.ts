import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppEnv } from "../config/env.js";
import { signAliyunRpc } from "./aliyun-signature.js";
import { readIntegrationJson } from "./integration-http.js";
import { PhoneVerificationSmsBudgetService } from "./phone-verification-sms-budget.service.js";

export type SmsSubmission =
  | { status: "ACCEPTED"; requestId: string; bizId: string }
  | { status: "REJECTED" }
  | { status: "UNKNOWN" };
export type SmsDeliveryQuery =
  | { status: "PENDING" }
  | { status: "DELIVERED" }
  | { status: "FAILED"; errorCode: string }
  | { status: "UNKNOWN"; errorCode: string };
const Receipt = z.object({
  Code: z.string(),
  RequestId: z.string().min(1).max(128),
  BizId: z.string().min(1).max(128).optional(),
});
const DeliveryReceipt = z.object({
  Code: z.string(),
  RequestId: z.string().min(1).max(128),
  SmsSendDetailDTOs: z
    .object({
      SmsSendDetailDTO: z.array(
        z.object({
          OutId: z.string().max(128).optional(),
          SendStatus: z.coerce.number().int(),
          ErrCode: z.string().max(128).optional(),
        }),
      ),
    })
    .optional(),
});
const Params = z.record(
  z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/),
  z
    .string()
    .min(1)
    .max(64)
    .regex(/^[^\r\n\x00-\x1f]*$/),
);

// Closed vocabulary from the provider's API error reference. Never echo an
// arbitrary Code/Message, even if it looks like an identifier (it may be PII).
// https://help.aliyun.com/zh/sms/developer-reference/api-error-codes
const ProviderCodes = [
  "isp.RAM_PERMISSION_DENY",
  "isp.SYSTEM_ERROR",
  "isp.GATEWAY_ERROR",
  "isv.SMS_SIGNATURE_SCENE_ILLEGAL",
  "isv.SIGN_STATE_ILLEGAL",
  "isv.SMS_SIGN_ILLEGAL",
  "isv.SMS_SIGNATURE_ILLEGAL",
  "isv.SMS_TEMPLATE_ILLEGAL",
  "isv.SMS_CONTENT_ILLEGAL",
  "isv.OUT_OF_SERVICE",
  "isv.AMOUNT_NOT_ENOUGH",
  "isv.PRODUCT_UN_SUBSCRIPT",
  "isv.PRODUCT_UNSUBSCRIBE",
  "isv.ACCOUNT_NOT_EXISTS",
  "isv.ACCOUNT_ABNORMAL",
  "isv.INVALID_PARAMETERS",
  "isv.MOBILE_NUMBER_ILLEGAL",
  "isv.MOBILE_COUNT_OVER_LIMIT",
  "isv.TEMPLATE_MISSING_PARAMETERS",
  "isv.TEMPLATE_PARAMS_ILLEGAL",
  "isv.INVALID_JSON_PARAM",
  "isv.PARAM_LENGTH_LIMIT",
  "isv.BUSINESS_LIMIT_CONTROL",
  "isv.DAY_LIMIT_CONTROL",
  "isv.MONTH_LIMIT_CONTROL",
  "isv.DENY_IP_RANGE",
  "isv.SECURITY_FROZEN_ACCOUNT",
  "isv.SMS_TEST_SIGN_TEMPLATE_LIMIT",
  "isv.SMS_TEST_TEMPLATE_PARAMS_ILLEGAL",
  "isv.SMS_TEST_NUMBER_LIMIT",
  "SignatureDoesNotMatch",
  "InvalidTimeStamp.Expired",
  "SignatureNonceUsed",
  "InvalidVersion",
  "InvalidAction.NotFound",
] as const;
const ProviderCodeByLowercase = new Map(
  ProviderCodes.map((code) => [code.toLowerCase(), code]),
);
const safeProviderCode = (code: string) =>
  ProviderCodeByLowercase.get(code.toLowerCase()) ?? "UNKNOWN_CODE";
const safeProviderRequestId = (id: string) =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)
    ? id.toLowerCase()
    : undefined;
type UnknownSubmissionStage =
  | "TRANSPORT"
  | "HTTP_RESPONSE"
  | "INVALID_RESPONSE"
  | "MISSING_BIZ_ID";

@Injectable()
export class AliyunSmsClient {
  private readonly logger = new Logger(AliyunSmsClient.name);
  constructor(
    private readonly config: ConfigService<AppEnv, true>,
    private readonly verificationBudget: PhoneVerificationSmsBudgetService,
  ) {}

  // INTERNAL adapter only. A durable outbox/idempotency owner must persist DISPATCHING
  // before calling. OutId is tracking metadata, NOT a provider deduplication guarantee.
  async submit(input: {
    phone: string;
    parameters: Record<string, string>;
    trackingId: string;
  }): Promise<SmsSubmission> {
    return this.sendWithTemplate(
      input,
      this.config.get("ALIYUN_SMS_TEMPLATE_CODE", { infer: true }),
    );
  }

  // Login/phone-binding fallback only. The template is selected from a dedicated
  // environment variable so it cannot be accidentally reused for safety alerts.
  async submitPhoneVerification(input: {
    phone: string;
    code: string;
    trackingId: string;
  }): Promise<SmsSubmission> {
    if (
      this.config.get("PHONE_VERIFICATION_SMS_ENABLED", { infer: true }) !==
      "true"
    )
      throw configurationNotReady("短信手机号验证门禁未开启");
    if (!/^\d{4,6}$/.test(input.code))
      throw new BadRequestException("短信验证码参数无效");
    return this.sendWithTemplate(
      {
        phone: input.phone,
        parameters: { code: input.code },
        trackingId: input.trackingId,
      },
      this.config.get("ALIYUN_SMS_PHONE_VERIFICATION_TEMPLATE_CODE", {
        infer: true,
      }),
      true,
    );
  }

  private async sendWithTemplate(
    input: {
      phone: string;
      parameters: Record<string, string>;
      trackingId: string;
    },
    template: string,
    verification = false,
  ): Promise<SmsSubmission> {
    if (
      this.config.get("SMS_PROVIDER", { infer: true }) !== "aliyun" ||
      this.config.get("SMS_SEND_ENABLED", { infer: true }) !== "true"
    )
      throw configurationNotReady("真实短信发送门禁未开启");
    if (
      !/^1[3-9]\d{9}$/.test(input.phone) ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(input.trackingId)
    )
      throw new BadRequestException("短信参数无效");
    const parsed = Params.safeParse(input.parameters);
    if (!parsed.success || Object.keys(parsed.data).length > 8)
      throw new BadRequestException("短信模板变量无效");
    const accessKeyId = this.config.get("ALIYUN_SMS_ACCESS_KEY_ID", {
      infer: true,
    });
    const accessKeySecret = this.config.get("ALIYUN_SMS_ACCESS_KEY_SECRET", {
      infer: true,
    });
    const signName = this.config.get("ALIYUN_SMS_SIGN_NAME", { infer: true });
    if (
      !accessKeyId.trim() ||
      !accessKeySecret.trim() ||
      !signName.trim() ||
      !/^SMS_[A-Za-z0-9]+$/.test(template)
    )
      throw configurationNotReady("短信渠道配置未就绪");
    let request: ReturnType<typeof signAliyunRpc>;
    try {
      request = signAliyunRpc({
        host: "dysmsapi.aliyuncs.com",
        action: "SendSms",
        version: "2017-05-25",
        accessKeyId,
        accessKeySecret,
        securityToken: this.config.get("ALIYUN_SMS_SECURITY_TOKEN", {
          infer: true,
        }),
        date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        nonce: randomUUID(),
        params: {
          PhoneNumbers: input.phone,
          SignName: signName,
          TemplateCode: template,
          TemplateParam: JSON.stringify(parsed.data),
          OutId: input.trackingId,
        },
      });
    } catch {
      throw configurationNotReady("短信渠道配置未就绪");
    }
    // Reserve durably only after gates, input and signing configuration passed.
    // The common verification branch covers every caller, not safety alerts.
    if (verification) await this.verificationBudget.reserve();
    let httpStatus: number | undefined;
    let unknownStage: UnknownSubmissionStage = "TRANSPORT";
    try {
      const response = await fetch(
        `https://dysmsapi.aliyuncs.com/?${request.query}`,
        {
          method: "POST",
          headers: request.headers,
          redirect: "error",
          signal: AbortSignal.timeout(8_000),
        },
      );
      if (
        Number.isInteger(response.status) &&
        response.status >= 100 &&
        response.status <= 599
      )
        httpStatus = response.status;
      unknownStage = response.ok ? "INVALID_RESPONSE" : "HTTP_RESPONSE";
      const receipt = Receipt.safeParse(await readIntegrationJson(response));
      if (!receipt.success) {
        if (verification)
          this.logUnknownSubmission("INVALID_RESPONSE", httpStatus);
        return { status: "UNKNOWN" };
      }
      if (receipt.data.Code !== "OK") {
        if (verification) {
          const providerRequestId = safeProviderRequestId(
            receipt.data.RequestId,
          );
          this.logSubmissionDiagnostic({
            status: "REJECTED",
            failureStage: "PROVIDER_REJECTED",
            providerCode: safeProviderCode(receipt.data.Code),
            ...(providerRequestId ? { providerRequestId } : {}),
          });
        }
        return { status: "REJECTED" };
      }
      if (!receipt.data.BizId) {
        if (verification)
          this.logUnknownSubmission("MISSING_BIZ_ID", httpStatus);
        return { status: "UNKNOWN" };
      }
      // Provider acceptance is NOT handset delivery. Do not mark notifications delivered.
      return {
        status: "ACCEPTED",
        requestId: receipt.data.RequestId,
        bizId: receipt.data.BizId,
      };
    } catch {
      if (verification) this.logUnknownSubmission(unknownStage, httpStatus);
      return { status: "UNKNOWN" };
    }
  }

  private logUnknownSubmission(
    failureStage: UnknownSubmissionStage,
    httpStatus?: number,
  ) {
    this.logSubmissionDiagnostic({
      status: "UNKNOWN",
      failureStage,
      ...(httpStatus === undefined ? {} : { httpStatus }),
    });
  }

  private logSubmissionDiagnostic(fields: Record<string, string | number>) {
    // Observability must never change submission outcomes or trigger a retry.
    try {
      this.logger.warn({
        event: "phone_verification_sms_submission",
        ...fields,
      });
    } catch {
      /* ignore a failed logger */
    }
  }

  async queryDelivery(input: {
    phone: string;
    bizId: string;
    sendDate: string;
    trackingId: string;
  }): Promise<SmsDeliveryQuery> {
    if (
      this.config.get("SMS_PROVIDER", { infer: true }) !== "aliyun" ||
      this.config.get("SAFETY_NOTIFICATION_RECEIPT_QUERY_ENABLED", {
        infer: true,
      }) !== "true"
    )
      throw new ServiceUnavailableException("短信回执查询门禁未开启");
    if (
      !/^1[3-9]\d{9}$/.test(input.phone) ||
      !/^[^\r\n\x00-\x1f]{1,128}$/.test(input.bizId) ||
      !/^\d{8}$/.test(input.sendDate) ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(input.trackingId)
    )
      throw new BadRequestException("短信回执查询参数无效");
    const accessKeyId = this.config.get("ALIYUN_SMS_ACCESS_KEY_ID", {
      infer: true,
    });
    const accessKeySecret = this.config.get("ALIYUN_SMS_ACCESS_KEY_SECRET", {
      infer: true,
    });
    if (!accessKeyId.trim() || !accessKeySecret.trim())
      throw new ServiceUnavailableException("短信渠道配置未就绪");
    let request: ReturnType<typeof signAliyunRpc>;
    try {
      request = signAliyunRpc({
        host: "dysmsapi.aliyuncs.com",
        action: "QuerySendDetails",
        version: "2017-05-25",
        accessKeyId,
        accessKeySecret,
        securityToken: this.config.get("ALIYUN_SMS_SECURITY_TOKEN", {
          infer: true,
        }),
        date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        nonce: randomUUID(),
        params: {
          PhoneNumber: input.phone,
          BizId: input.bizId,
          SendDate: input.sendDate,
          PageSize: "10",
          CurrentPage: "1",
        },
      });
    } catch {
      throw new ServiceUnavailableException("短信渠道配置未就绪");
    }
    try {
      const response = await fetch(
        `https://dysmsapi.aliyuncs.com/?${request.query}`,
        {
          method: "POST",
          headers: request.headers,
          redirect: "error",
          signal: AbortSignal.timeout(8_000),
        },
      );
      const receipt = DeliveryReceipt.safeParse(
        await readIntegrationJson(response),
      );
      if (!receipt.success || receipt.data.Code !== "OK")
        return { status: "UNKNOWN", errorCode: "SMS_RECEIPT_QUERY_REJECTED" };
      const details = receipt.data.SmsSendDetailDTOs?.SmsSendDetailDTO ?? [];
      const detail = details.find(
        (candidate) => candidate.OutId === input.trackingId,
      );
      if (!detail) return { status: "PENDING" };
      if (detail.SendStatus === 1) return { status: "PENDING" };
      if (detail.SendStatus === 3) return { status: "DELIVERED" };
      if (detail.SendStatus === 2)
        return {
          status: "FAILED",
          errorCode: normalizeDeliveryError(detail.ErrCode),
        };
      return { status: "UNKNOWN", errorCode: "SMS_RECEIPT_STATUS_UNKNOWN" };
    } catch {
      return { status: "UNKNOWN", errorCode: "SMS_RECEIPT_QUERY_UNAVAILABLE" };
    }
  }
}

const normalizeDeliveryError = (value?: string) => {
  const safe = value
    ?.trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_.-]/g, "_");
  return safe ? `SMS_DELIVERY_${safe.slice(0, 64)}` : "SMS_DELIVERY_FAILED";
};

const configurationNotReady = (message: string) =>
  new ServiceUnavailableException({
    statusCode: 503,
    code: "CONFIGURATION_NOT_READY",
    message,
  });
