import { ServiceUnavailableException } from "@nestjs/common";
import { PaymentProvider } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { PaymentGatewayService } from "./payment-gateway.service.js";

const config = (values: Record<string, string>) =>
  ({ get: (key: string) => values[key] ?? "" }) as never;

describe("PaymentGatewayService", () => {
  it("prepares a local-only mock reference without external calls", () => {
    const gateway = new PaymentGatewayService(
      config({ PAYMENT_PROVIDER: "mock" }),
    );
    expect(gateway.prepare("PAY-1")).toEqual({
      provider: PaymentProvider.MOCK,
      providerReference: "mock-prepay-PAY-1",
    });
  });

  it("builds the internal WeChat JSAPI request in integer fen", () => {
    const gateway = new PaymentGatewayService(
      config({
        PAYMENT_PROVIDER: "wechat",
        WECHAT_MINIAPP_APP_ID: "wx-app-id",
        WECHAT_MCH_ID: "merchant-id",
        WECHAT_PAY_NOTIFY_URL:
          "https://api.example.com/v1/payments/wechat/notify",
      }),
    );
    expect(
      gateway.buildWechatJsapiRequest({
        description: "中原到家-肩颈舒缓",
        outTradeNo: "PAY-1",
        totalFen: 19_800,
        payerOpenId: "openid-placeholder",
      }),
    ).toEqual({
      appid: "wx-app-id",
      mchid: "merchant-id",
      description: "中原到家-肩颈舒缓",
      out_trade_no: "PAY-1",
      notify_url: "https://api.example.com/v1/payments/wechat/notify",
      amount: { total: 19_800, currency: "CNY" },
      payer: { openid: "openid-placeholder" },
    });
  });

  it("refuses a non-durable direct WeChat preparation", () => {
    const gateway = new PaymentGatewayService(
      config({ PAYMENT_PROVIDER: "wechat" }),
    );
    expect(() => gateway.prepare("PAY-1")).toThrow(ServiceUnavailableException);
  });
});
