import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { createCipheriv, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeWechatNotification,
  parseWechatTransaction,
  verifyWechatMessage,
  type WechatVerifierConfig,
} from "./wechat-pay.protocol.js";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const config: WechatVerifierConfig = {
  publicKeyId: "PUB_KEY_ID_TEST",
  publicKeyPem: keys.publicKey
    .export({ type: "spki", format: "pem" })
    .toString(),
  apiV3Key: "0".repeat(32),
  appId: "test-app",
  merchantId: "1234567890",
};
const now = Date.parse("2026-10-03T01:00:00Z");
const transaction = {
  appid: config.appId,
  mchid: config.merchantId,
  out_trade_no: "PAYTEST123",
  transaction_id: "transaction-1",
  trade_type: "JSAPI",
  trade_state: "SUCCESS",
  success_time: "2026-10-03T00:59:00+00:00",
  amount: { total: 19800, currency: "CNY" },
  payer: { openid: "must-not-persist" },
};

function signed(rawBody: Buffer, timestamp = String(now / 1000)) {
  const nonce = "signature-nonce";
  return {
    "wechatpay-timestamp": timestamp,
    "wechatpay-nonce": nonce,
    "wechatpay-serial": config.publicKeyId,
    "wechatpay-signature": sign(
      "RSA-SHA256",
      Buffer.concat([
        Buffer.from(`${timestamp}\n${nonce}\n`),
        rawBody,
        Buffer.from("\n"),
      ]),
      keys.privateKey,
    ).toString("base64"),
  };
}

function notification(overrides: Record<string, unknown> = {}) {
  const nonce = "123456789012";
  const aad = "transaction";
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(config.apiV3Key),
    Buffer.from(nonce),
  );
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ ...transaction, ...overrides })),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
  return Buffer.from(
    JSON.stringify(
      {
        id: "event-1",
        event_type: "TRANSACTION.SUCCESS",
        resource_type: "encrypt-resource",
        resource: {
          original_type: "transaction",
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
}

describe("Wechat Pay signed and encrypted protocol", () => {
  it("verifies original bytes, decrypts and strips sensitive payer fields", () => {
    const raw = notification();
    const result = decodeWechatNotification(raw, signed(raw), config, now);
    expect(result).toMatchObject({
      eventId: "event-1",
      transaction: {
        amount: { total: 19800 },
        transaction_id: "transaction-1",
      },
    });
    expect(result.transaction).not.toHaveProperty("payer");
  });
  it("rejects changes to body whitespace even if parsed JSON is identical", () => {
    const raw = notification();
    const changed = Buffer.from(JSON.stringify(JSON.parse(raw.toString())));
    expect(() =>
      verifyWechatMessage(changed, signed(raw), config, now),
    ).toThrow(UnauthorizedException);
  });
  it.each([-301, 301])(
    "rejects timestamp outside five minutes (%s seconds)",
    (offset) => {
      const raw = notification();
      expect(() =>
        verifyWechatMessage(
          raw,
          signed(raw, String(now / 1000 + offset)),
          config,
          now,
        ),
      ).toThrow(UnauthorizedException);
    },
  );
  it("rejects unknown platform key ID and duplicate headers", () => {
    const raw = notification();
    expect(() =>
      verifyWechatMessage(
        raw,
        { ...signed(raw), "wechatpay-serial": "PUB_KEY_ID_OTHER" },
        config,
        now,
      ),
    ).toThrow(UnauthorizedException);
    expect(() =>
      verifyWechatMessage(
        raw,
        { ...signed(raw), "wechatpay-nonce": ["a", "b"] },
        config,
        now,
      ),
    ).toThrow(UnauthorizedException);
  });
  it("rejects SIGNTEST probes", () => {
    const raw = notification();
    expect(() =>
      verifyWechatMessage(
        raw,
        { ...signed(raw), "wechatpay-signature": "WECHATPAY/SIGNTEST/abc" },
        config,
        now,
      ),
    ).toThrow(UnauthorizedException);
  });
  it("rejects authenticated ciphertext that cannot be decrypted with the APIv3 key", () => {
    const raw = notification();
    expect(() =>
      decodeWechatNotification(
        raw,
        signed(raw),
        { ...config, apiV3Key: "1".repeat(32) },
        now,
      ),
    ).toThrow(BadRequestException);
  });
  it.each([
    { mchid: "other" },
    { appid: "other" },
    { trade_type: "NATIVE" },
    { trade_state: "CLOSED" },
    { transaction_id: undefined },
    { amount: { total: 198.5, currency: "CNY" } },
    { amount: { total: 19800, currency: "USD" } },
  ])("rejects mismatched business payload %j", (changes) => {
    const raw = notification(changes);
    expect(() =>
      decodeWechatNotification(raw, signed(raw), config, now),
    ).toThrow(BadRequestException);
  });
  it("allows unpaid query results without success-only fields", () => {
    expect(
      parseWechatTransaction(
        {
          ...transaction,
          trade_state: "NOTPAY",
          transaction_id: undefined,
          success_time: undefined,
        },
        config,
      ).trade_state,
    ).toBe("NOTPAY");
  });
});
