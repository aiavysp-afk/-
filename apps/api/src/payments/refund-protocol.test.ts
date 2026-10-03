import { createCipheriv, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeWechatRefundNotification,
  parseWechatRefund,
} from "./wechat-pay.protocol.js";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const config = {
  merchantId: "1234567890",
  appId: "test-app",
  apiV3Key: "0".repeat(32),
  publicKeyId: "PUB_KEY_ID_REFUND_TEST",
  publicKeyPem: keys.publicKey
    .export({ type: "spki", format: "pem" })
    .toString(),
};
const result = {
  mchid: config.merchantId,
  transaction_id: "TX1",
  out_trade_no: "PAY1",
  out_refund_no: "RF1",
  refund_id: "WRF1",
  refund_status: "SUCCESS",
  success_time: new Date().toISOString(),
  amount: { total: 19880, refund: 19880, currency: "CNY" },
  user_received_account: "must-not-persist",
};
function notification(changes = {}, event = "REFUND.SUCCESS") {
  const nonce = "123456789012",
    aad = "refund";
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(config.apiV3Key),
    Buffer.from(nonce),
  );
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ ...result, ...changes })),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
  const body = Buffer.from(
    JSON.stringify(
      {
        id: "refund-event",
        event_type: event,
        resource_type: "encrypt-resource",
        resource: {
          original_type: "refund",
          algorithm: "AEAD_AES_256_GCM",
          nonce,
          associated_data: aad,
          ciphertext,
        },
      },
      null,
      2,
    ),
  );
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers = {
    "wechatpay-timestamp": timestamp,
    "wechatpay-nonce": "nonce",
    "wechatpay-serial": config.publicKeyId,
    "wechatpay-signature": sign(
      "RSA-SHA256",
      Buffer.concat([
        Buffer.from(`${timestamp}\nnonce\n`),
        body,
        Buffer.from("\n"),
      ]),
      keys.privateKey,
    ).toString("base64"),
  };
  return { body, headers };
}
describe("signed refund protocol", () => {
  it("decrypts and strips recipient account details", () => {
    const { body, headers } = notification();
    const decoded = decodeWechatRefundNotification(body, headers, config);
    expect(decoded.result.status).toBe("SUCCESS");
    expect(decoded.result).not.toHaveProperty("user_received_account");
  });
  it.each(["ABNORMAL", "CLOSED"])(
    "accepts authenticated %s without success time",
    (status) => {
      const { body, headers } = notification(
        { refund_status: status, success_time: undefined },
        `REFUND.${status}`,
      );
      expect(
        decodeWechatRefundNotification(body, headers, config).result.status,
      ).toBe(status);
    },
  );
  it("rejects changed raw whitespace", () => {
    const { body, headers } = notification();
    expect(() =>
      decodeWechatRefundNotification(
        Buffer.from(JSON.stringify(JSON.parse(body.toString()))),
        headers,
        config,
      ),
    ).toThrow();
  });
  it.each([
    { mchid: "wrong" },
    { amount: { total: 19880, refund: 99999 } },
    { success_time: undefined },
  ])("rejects invalid resource %j", (changes) => {
    const { body, headers } = notification(changes);
    expect(() =>
      decodeWechatRefundNotification(body, headers, config),
    ).toThrow();
  });
  it("requires envelope and resource outcome to agree", () => {
    const { body, headers } = notification({}, "REFUND.CLOSED");
    expect(() =>
      decodeWechatRefundNotification(body, headers, config),
    ).toThrow();
  });
  it("binds a query without mchid to its signed merchant request context", () => {
    expect(
      parseWechatRefund(
        { ...result, mchid: undefined, status: "SUCCESS" },
        config.merchantId,
      ).mchid,
    ).toBe(config.merchantId);
  });
});
