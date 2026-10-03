import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, randomBytes, sign, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AppEnv } from "../config/env.js";
import {
  decodeWechatNotification,
  decodeWechatRefundNotification,
  parseWechatRefund,
  parseWechatTransaction,
  verifyWechatMessage,
  type WechatHeaders,
  type WechatVerifierConfig,
} from "./wechat-pay.protocol.js";

@Injectable()
export class WechatPayClient {
  constructor(private readonly config: ConfigService<AppEnv, true>) {}

  assertEnabled() {
    if (this.config.get("PAYMENT_PROVIDER", { infer: true }) !== "wechat")
      throw new NotFoundException("接口不存在");
  }

  verifierConfig(): WechatVerifierConfig {
    this.assertEnabled();
    try {
      const publicKeyId = this.config.get("WECHAT_PAY_PUBLIC_KEY_ID", {
        infer: true,
      });
      const path = publicKeyId
        ? this.config.get("WECHAT_PAY_PUBLIC_KEY_PATH", { infer: true })
        : this.config.get("WECHAT_PAY_PLATFORM_CERT_PATH", { infer: true });
      return {
        publicKeyId,
        publicKeyPem: readFileSync(path, "utf8"),
        apiV3Key: this.config.get("WECHAT_PAY_API_V3_KEY", { infer: true }),
        appId: this.config.get("WECHAT_MINIAPP_APP_ID", { infer: true }),
        merchantId: this.config.get("WECHAT_MCH_ID", { infer: true }),
      };
    } catch {
      throw new ServiceUnavailableException("微信支付验签材料尚未就绪");
    }
  }

  decodeNotification(rawBody: Buffer, headers: WechatHeaders) {
    return decodeWechatNotification(rawBody, headers, this.verifierConfig());
  }

  async queryTransaction(outTradeNo: string) {
    const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(this.config.get("WECHAT_MCH_ID", { infer: true }))}`;
    return parseWechatTransaction(
      await this.request(path),
      this.verifierConfig(),
    );
  }

  async queryRefund(outRefundNo: string) {
    const result = await this.request(
      `/v3/refund/domestic/refunds/${encodeURIComponent(outRefundNo)}`,
    );
    return parseWechatRefund(
      result,
      this.config.get("WECHAT_MCH_ID", { infer: true }),
    );
  }

  decodeRefundNotification(rawBody: Buffer, headers: WechatHeaders) {
    return decodeWechatRefundNotification(
      rawBody,
      headers,
      this.verifierConfig(),
    );
  }

  async requestTradeBill(date: string) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ||
      new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
    )
      throw new BadRequestException("账单日期无效");
    const result = await this.request(
      `/v3/bill/tradebill?bill_date=${date}&bill_type=ALL`,
    );
    if (
      result.hash_type !== "SHA1" ||
      typeof result.hash_value !== "string" ||
      !/^[a-fA-F0-9]{40}$/.test(result.hash_value) ||
      typeof result.download_url !== "string"
    )
      throw new BadGatewayException("微信交易账单元数据无效");
    return {
      hashType: "SHA1" as const,
      hashValue: result.hash_value.toLowerCase(),
      downloadUrl: result.download_url,
    };
  }

  async downloadTradeBill(metadata: {
    hashType: "SHA1";
    hashValue: string;
    downloadUrl: string;
  }) {
    const url = new URL(metadata.downloadUrl);
    if (
      url.origin !== "https://api.mch.weixin.qq.com" ||
      !["/v3/bill/downloadurl", "/v3/billdownload/file"].includes(
        url.pathname,
      ) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new BadRequestException("账单下载地址无效");
    const response = await this.send(url.pathname + url.search);
    if (!response.ok) throw new BadGatewayException("微信账单下载失败");
    const bytes = await this.readBounded(response, 20 * 1024 * 1024);
    // Download responses have no Wechatpay signature: integrity comes from signed metadata.
    if (createHash("sha1").update(bytes).digest("hex") !== metadata.hashValue)
      throw new BadGatewayException("微信账单摘要不匹配");
    return bytes;
  }

  buildRefundRequest(input: {
    transactionId: string;
    outRefundNo: string;
    refundFen: number;
    totalFen: number;
    reason: string;
  }) {
    if (
      !/^[A-Za-z0-9_\-|*@]{1,64}$/.test(input.outRefundNo) ||
      !input.transactionId ||
      !Number.isSafeInteger(input.refundFen) ||
      !Number.isSafeInteger(input.totalFen) ||
      input.refundFen <= 0 ||
      input.refundFen > input.totalFen ||
      Buffer.byteLength(input.reason) > 80
    )
      throw new BadRequestException("退款参数无效");
    return {
      transaction_id: input.transactionId,
      out_refund_no: input.outRefundNo,
      reason: input.reason,
      amount: {
        refund: input.refundFen,
        total: input.totalFen,
        currency: "CNY" as const,
      },
    };
  }

  assertRefundEnabled() {
    this.assertEnabled();
    if (
      this.config.get("WECHAT_PAY_REFUND_ENABLED", { infer: true }) !== "true"
    )
      throw new ServiceUnavailableException("真实退款提交门禁未开启");
    if (
      !/^https:\/\//.test(
        this.config.get("WECHAT_PAY_REFUND_NOTIFY_URL", { infer: true }),
      )
    )
      throw new ServiceUnavailableException("退款通知地址未配置");
  }

  async submitRefund(
    request: ReturnType<WechatPayClient["buildRefundRequest"]>,
  ) {
    this.assertRefundEnabled();
    const body = JSON.stringify({
      ...request,
      notify_url: this.config.get("WECHAT_PAY_REFUND_NOTIFY_URL", {
        infer: true,
      }),
    });
    return parseWechatRefund(
      await this.request("/v3/refund/domestic/refunds", "POST", body),
      this.config.get("WECHAT_MCH_ID", { infer: true }),
    );
  }

  private async request(
    path: string,
    method: "GET" | "POST" = "GET",
    body = "",
  ): Promise<Record<string, unknown>> {
    const response = await this.send(path, method, body);
    const raw = await this.readBounded(response, 1_048_576);
    const headers: WechatHeaders = {};
    for (const name of [
      "wechatpay-timestamp",
      "wechatpay-nonce",
      "wechatpay-serial",
      "wechatpay-signature",
    ])
      headers[name] = response.headers.get(name) ?? undefined;
    try {
      verifyWechatMessage(raw, headers, this.verifierConfig());
    } catch {
      throw new BadGatewayException("微信支付响应验签失败");
    }
    if (!response.ok)
      throw new BadGatewayException(`微信支付接口返回 ${response.status}`);
    try {
      const result: unknown = JSON.parse(raw.toString("utf8"));
      if (!result || typeof result !== "object" || Array.isArray(result))
        throw new Error("Invalid JSON");
      return result as Record<string, unknown>;
    } catch {
      throw new BadGatewayException("微信支付响应格式无效");
    }
  }

  private async send(path: string, method: "GET" | "POST" = "GET", body = "") {
    this.assertEnabled();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(16).toString("hex");
    let signature: string;
    try {
      signature = sign(
        "RSA-SHA256",
        Buffer.from(`${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`),
        readFileSync(
          this.config.get("WECHAT_PAY_PRIVATE_KEY_PATH", { infer: true }),
        ),
      ).toString("base64");
    } catch {
      throw new ServiceUnavailableException("微信支付商户签名材料尚未就绪");
    }
    const merchantId = this.config.get("WECHAT_MCH_ID", { infer: true });
    const serial = this.config.get("WECHAT_PAY_MERCHANT_SERIAL_NO", {
      infer: true,
    });
    if (!/^[0-9]+$/.test(merchantId) || !/^[a-fA-F0-9]+$/.test(serial))
      throw new ServiceUnavailableException("微信支付商户配置无效");
    try {
      const verifier = this.verifierConfig();
      return await fetch(`https://api.mch.weixin.qq.com${path}`, {
        method,
        ...(method === "POST" ? { body } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(8000),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Wechatpay-Serial":
            verifier.publicKeyId ||
            new X509Certificate(verifier.publicKeyPem).serialNumber,
          Authorization: `WECHATPAY2-SHA256-RSA2048 mchid="${merchantId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${serial}",signature="${signature}"`,
        },
      });
    } catch {
      throw new BadGatewayException("微信支付接口暂不可达");
    }
  }

  private async readBounded(response: Response, maxBytes: number) {
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes)
          throw new BadGatewayException("微信支付响应超出大小限制");
        chunks.push(value);
      }
      return Buffer.concat(chunks);
    } finally {
      await reader.cancel();
    }
  }
}
