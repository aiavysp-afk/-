import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { createDecipheriv, verify, X509Certificate } from "node:crypto";
import { z } from "zod";

const Identifier = z.string().min(1).max(128);
export const WechatTransactionSchema = z.object({
  appid: Identifier,
  mchid: Identifier,
  out_trade_no: Identifier,
  transaction_id: Identifier.optional(),
  trade_type: z.string().optional(),
  trade_state: z.enum([
    "SUCCESS",
    "REFUND",
    "NOTPAY",
    "CLOSED",
    "REVOKED",
    "USERPAYING",
    "PAYERROR",
    "ACCEPTED",
  ]),
  success_time: z.iso.datetime({ offset: true }).optional(),
  amount: z.object({
    total: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    currency: z.literal("CNY"),
  }),
});
export type WechatTransaction = z.infer<typeof WechatTransactionSchema>;

const WechatQuerySchema = WechatTransactionSchema.extend({
  // Official unpaid/closed query responses may omit the amount and trade type.
  amount: WechatTransactionSchema.shape.amount.partial().optional(),
});
export type WechatQueryResult = z.infer<typeof WechatQuerySchema>;

export function parseWechatQueryTransaction(
  value: unknown,
  config: Pick<WechatVerifierConfig, "appId" | "merchantId">,
): WechatQueryResult {
  const parsed = WechatQuerySchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.appid !== config.appId ||
    parsed.data.mchid !== config.merchantId ||
    (parsed.data.trade_type && parsed.data.trade_type !== "JSAPI")
  )
    throw new BadRequestException("微信查单身份或格式无效");
  // Settlement still requires a complete amount, currency, transaction ID and success time.
  if (parsed.data.trade_state === "SUCCESS")
    return parseWechatTransaction(value, config);
  return parsed.data;
}

const NotificationSchema = z.object({
  id: Identifier,
  event_type: z.literal("TRANSACTION.SUCCESS"),
  resource_type: z.literal("encrypt-resource"),
  resource: z.object({
    original_type: z.literal("transaction"),
    algorithm: z.literal("AEAD_AES_256_GCM"),
    ciphertext: z.string().min(1).max(1_048_576),
    nonce: z.string().min(1).max(32),
    associated_data: z.string().max(128).optional(),
  }),
});

const RefundResultFields = {
  out_trade_no: Identifier,
  transaction_id: Identifier,
  out_refund_no: z.string().min(1).max(64),
  refund_id: Identifier,
  success_time: z.iso.datetime({ offset: true }).optional(),
  amount: z.object({
    total: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    refund: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    currency: z.literal("CNY").optional(),
  }),
};
const RefundQuerySchema = z.object({
  ...RefundResultFields,
  status: z.enum(["SUCCESS", "PROCESSING", "CLOSED", "ABNORMAL"]),
  mchid: Identifier.optional(),
});
const RefundNotificationSchema = NotificationSchema.extend({
  event_type: z.enum(["REFUND.SUCCESS", "REFUND.ABNORMAL", "REFUND.CLOSED"]),
  resource: NotificationSchema.shape.resource.extend({
    original_type: z.literal("refund"),
  }),
});
const RefundResourceSchema = z.object({
  ...RefundResultFields,
  mchid: Identifier,
  refund_status: z.enum(["SUCCESS", "PROCESSING", "CLOSED", "ABNORMAL"]),
});
export type WechatRefundResult = z.infer<typeof RefundQuerySchema> & {
  mchid: string;
};

export function parseWechatRefund(
  value: unknown,
  merchantId: string,
): WechatRefundResult {
  const parsed = RefundQuerySchema.safeParse(value);
  if (
    !parsed.success ||
    (parsed.data.mchid && parsed.data.mchid !== merchantId) ||
    parsed.data.amount.refund > parsed.data.amount.total ||
    (parsed.data.status === "SUCCESS" && !parsed.data.success_time)
  )
    throw new BadRequestException("微信退款结果身份、金额或格式无效");
  // Query response has no mchid: it is bound by our merchant-signed request and verified response.
  return { ...parsed.data, mchid: merchantId };
}

function decryptResource(
  resource:
    | z.infer<typeof NotificationSchema>["resource"]
    | z.infer<typeof RefundNotificationSchema>["resource"],
  apiV3Key: string,
) {
  const encrypted = Buffer.from(resource.ciphertext, "base64");
  if (encrypted.length <= 16 || Buffer.byteLength(apiV3Key) !== 32)
    throw new Error("Invalid encrypted resource");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(apiV3Key),
    Buffer.from(resource.nonce),
  );
  decipher.setAuthTag(encrypted.subarray(-16));
  decipher.setAAD(Buffer.from(resource.associated_data ?? ""));
  const cleartext = Buffer.concat([
    decipher.update(encrypted.subarray(0, -16)),
    decipher.final(),
  ]);
  return JSON.parse(cleartext.toString("utf8")) as unknown;
}

export function decodeWechatRefundNotification(
  rawBody: Buffer,
  headers: WechatHeaders,
  config: WechatVerifierConfig,
  now = Date.now(),
) {
  verifyWechatMessage(rawBody, headers, config, now);
  try {
    const notification = RefundNotificationSchema.parse(
      JSON.parse(rawBody.toString("utf8")),
    );
    const resource = RefundResourceSchema.parse(
      decryptResource(notification.resource, config.apiV3Key),
    );
    const result = parseWechatRefund(
      { ...resource, status: resource.refund_status },
      config.merchantId,
    );
    if (notification.event_type !== `REFUND.${result.status}`)
      throw new Error("Refund event type mismatch");
    return { eventId: notification.id, result };
  } catch {
    throw new BadRequestException("微信退款通知解密或校验失败");
  }
}

export type WechatHeaders = Record<string, string | string[] | undefined>;
export interface WechatVerifierConfig {
  publicKeyId: string;
  publicKeyPem: string;
  apiV3Key: string;
  appId: string;
  merchantId: string;
}

export function verifyWechatMessage(
  rawBody: Buffer,
  headers: WechatHeaders,
  config: WechatVerifierConfig,
  now = Date.now(),
) {
  const getHeader = (name: string) => {
    const value = headers[name];
    if (typeof value !== "string" || !value || value.length > 4096)
      throw new UnauthorizedException("微信支付签名头无效");
    return value;
  };
  const timestamp = getHeader("wechatpay-timestamp");
  const nonce = getHeader("wechatpay-nonce");
  const serial = getHeader("wechatpay-serial");
  const signature = getHeader("wechatpay-signature");
  if (
    !/^\d{1,12}$/.test(timestamp) ||
    Math.abs(now / 1000 - Number(timestamp)) > 300 ||
    signature.startsWith("WECHATPAY/SIGNTEST/")
  ) {
    throw new UnauthorizedException("微信支付签名过期或无效");
  }
  let key = config.publicKeyPem;
  let expectedSerial = config.publicKeyId;
  if (!expectedSerial) {
    const certificate = new X509Certificate(key);
    if (
      now < Date.parse(certificate.validFrom) ||
      now > Date.parse(certificate.validTo)
    )
      throw new UnauthorizedException("微信支付平台证书已过期");
    expectedSerial = certificate.serialNumber;
    key = certificate.publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
  }
  // Public key IDs are case sensitive. Certificate hex serials are not.
  const matches = expectedSerial.startsWith("PUB_KEY_ID_")
    ? serial === expectedSerial
    : serial.toUpperCase() === expectedSerial.toUpperCase();
  if (!matches || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature))
    throw new UnauthorizedException("微信支付验签标识无效");
  const message = Buffer.concat([
    Buffer.from(`${timestamp}\n${nonce}\n`),
    rawBody,
    Buffer.from("\n"),
  ]);
  if (!verify("RSA-SHA256", message, key, Buffer.from(signature, "base64")))
    throw new UnauthorizedException("微信支付验签失败");
}

export function parseWechatTransaction(
  value: unknown,
  config: Pick<WechatVerifierConfig, "appId" | "merchantId">,
): WechatTransaction {
  const parsed = WechatTransactionSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.appid !== config.appId ||
    parsed.data.mchid !== config.merchantId ||
    (parsed.data.trade_type && parsed.data.trade_type !== "JSAPI")
  ) {
    throw new BadRequestException("微信支付交易身份或格式无效");
  }
  if (
    parsed.data.trade_state === "SUCCESS" &&
    (!parsed.data.transaction_id || !parsed.data.success_time)
  )
    throw new BadRequestException("成功交易缺少流水或支付时间");
  return parsed.data;
}

export function decodeWechatNotification(
  rawBody: Buffer,
  headers: WechatHeaders,
  config: WechatVerifierConfig,
  now = Date.now(),
) {
  verifyWechatMessage(rawBody, headers, config, now);
  try {
    const notification = NotificationSchema.parse(
      JSON.parse(rawBody.toString("utf8")),
    );
    const transaction = parseWechatTransaction(
      decryptResource(notification.resource, config.apiV3Key),
      config,
    );
    if (transaction.trade_state !== "SUCCESS")
      throw new Error("Unexpected trade state");
    return { eventId: notification.id, transaction };
  } catch {
    // Never include ciphertext, cleartext, headers or key material in errors/logs.
    throw new BadRequestException("微信支付通知解密或校验失败");
  }
}
