import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppEnv } from "../config/env.js";
import { signAliyunRpc } from "./aliyun-signature.js";
import { readIntegrationJson } from "./integration-http.js";

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

@Injectable()
export class AliyunSmsClient {
  constructor(private readonly config: ConfigService<AppEnv, true>) {}

  // INTERNAL adapter only. A durable outbox/idempotency owner must persist DISPATCHING
  // before calling. OutId is tracking metadata, NOT a provider deduplication guarantee.
  async submit(input: {
    phone: string;
    parameters: Record<string, string>;
    trackingId: string;
  }): Promise<SmsSubmission> {
    if (
      this.config.get("SMS_PROVIDER", { infer: true }) !== "aliyun" ||
      this.config.get("SMS_SEND_ENABLED", { infer: true }) !== "true"
    )
      throw new ServiceUnavailableException("真实短信发送门禁未开启");
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
    const template = this.config.get("ALIYUN_SMS_TEMPLATE_CODE", {
      infer: true,
    });
    if (
      !accessKeyId.trim() ||
      !accessKeySecret.trim() ||
      !signName.trim() ||
      !/^SMS_[A-Za-z0-9]+$/.test(template)
    )
      throw new ServiceUnavailableException("短信渠道配置未就绪");
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
      const receipt = Receipt.safeParse(await readIntegrationJson(response));
      if (!receipt.success) return { status: "UNKNOWN" };
      if (receipt.data.Code !== "OK") return { status: "REJECTED" };
      if (!receipt.data.BizId) return { status: "UNKNOWN" };
      // Provider acceptance is NOT handset delivery. Do not mark notifications delivered.
      return {
        status: "ACCEPTED",
        requestId: receipt.data.RequestId,
        bizId: receipt.data.BizId,
      };
    } catch {
      return { status: "UNKNOWN" };
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
