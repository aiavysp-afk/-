import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PaymentProvider } from "@prisma/client";
import type { AppEnv } from "../config/env.js";

export interface WechatJsapiPrepareInput {
  description: string;
  outTradeNo: string;
  totalFen: number;
  payerOpenId: string;
}

export interface WechatJsapiRequest {
  appid: string;
  mchid: string;
  description: string;
  out_trade_no: string;
  notify_url: string;
  amount: { total: number; currency: "CNY" };
  payer: { openid: string };
}

@Injectable()
export class PaymentGatewayService {
  constructor(private readonly config: ConfigService<AppEnv, true>) {}

  configuredProvider() {
    return this.config.get("PAYMENT_PROVIDER", { infer: true }) === "mock"
      ? PaymentProvider.MOCK
      : PaymentProvider.WECHAT;
  }

  prepare(merchantPaymentNo: string) {
    const provider = this.configuredProvider();
    if (provider === PaymentProvider.MOCK) {
      return {
        provider,
        providerReference: `mock-prepay-${merchantPaymentNo}`,
      };
    }
    throw new ServiceUnavailableException(
      "微信 JSAPI 支付尚未完成受控开通，未发起真实预下单",
    );
  }

  buildWechatJsapiRequest(input: WechatJsapiPrepareInput): WechatJsapiRequest {
    return {
      appid: this.config.get("WECHAT_MINIAPP_APP_ID", { infer: true }),
      mchid: this.config.get("WECHAT_MCH_ID", { infer: true }),
      description: input.description,
      out_trade_no: input.outTradeNo,
      notify_url: this.config.get("WECHAT_PAY_NOTIFY_URL", { infer: true }),
      amount: { total: input.totalFen, currency: "CNY" },
      payer: { openid: input.payerOpenId },
    };
  }
}
