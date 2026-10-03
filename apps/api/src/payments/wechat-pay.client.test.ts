import { BadGatewayException, BadRequestException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WechatPayClient } from "./wechat-pay.client.js";

vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));
const merchant = generateKeyPairSync("rsa", { modulusLength: 2048 });
const platform = generateKeyPairSync("rsa", { modulusLength: 2048 });
const env: Record<string, string> = { PAYMENT_PROVIDER: "wechat", WECHAT_MCH_ID: "1234567890", WECHAT_MINIAPP_APP_ID: "test-app", WECHAT_PAY_MERCHANT_SERIAL_NO: "ABC123", WECHAT_PAY_PRIVATE_KEY_PATH: "merchant-fixture", WECHAT_PAY_PUBLIC_KEY_ID: "PUB_KEY_ID_TEST", WECHAT_PAY_PUBLIC_KEY_PATH: "platform-fixture", WECHAT_PAY_API_V3_KEY: "0".repeat(32) };
const client = () => new WechatPayClient({ get: (key: string) => env[key] ?? "" } as never);
function response(body: Record<string, unknown>, status = 200, corrupt = false) {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = "test-nonce";
  return new Response(raw, { status, headers: { "wechatpay-timestamp": timestamp, "wechatpay-nonce": nonce, "wechatpay-serial": "PUB_KEY_ID_TEST", "wechatpay-signature": sign("RSA-SHA256", Buffer.from(`${timestamp}\n${nonce}\n${corrupt ? raw + "tampered" : raw}\n`), platform.privateKey).toString("base64") } });
}
describe("WechatPayClient", () => {
  beforeEach(() => {
    vi.mocked(readFileSync).mockImplementation(((path: string) => path === "merchant-fixture" ? merchant.privateKey.export({ type: "pkcs8", format: "pem" }).toString() : platform.publicKey.export({ type: "spki", format: "pem" }).toString()) as never);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
  it("signs the exact encoded GET path and verifies the provider response", async () => {
    const remote = vi.fn().mockResolvedValue(response({ appid: "test-app", mchid: "1234567890", out_trade_no: "PAY-1", trade_state: "NOTPAY", amount: { total: 19800, currency: "CNY" } }));
    vi.stubGlobal("fetch", remote);
    expect((await client().queryTransaction("PAY-1")).trade_state).toBe("NOTPAY");
    const [url, options] = remote.mock.calls[0]!;
    expect(url).toBe("https://api.mch.weixin.qq.com/v3/pay/transactions/out-trade-no/PAY-1?mchid=1234567890");
    const auth = options.headers.Authorization as string;
    const timestamp = auth.match(/timestamp="([^"]+)"/)![1];
    const nonce = auth.match(/nonce_str="([^"]+)"/)![1];
    const signature = auth.match(/signature="([^"]+)"/)![1]!;
    const path = new URL(url).pathname + new URL(url).search;
    expect(verify("RSA-SHA256", Buffer.from(`GET\n${path}\n${timestamp}\n${nonce}\n\n`), merchant.publicKey, Buffer.from(signature, "base64"))).toBe(true);
    expect(options.redirect).toBe("error");
  });
  it("rejects tampered responses before reading business fields", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ arbitrary: "value" }, 200, true)));
    await expect(client().queryTransaction("PAY-1")).rejects.toBeInstanceOf(BadGatewayException);
  });
  it("returns generic provider errors without payload or credentials", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ secret: "must-not-leak" }, 400)));
    await expect(client().queryTransaction("PAY-1")).rejects.toThrow("微信支付接口返回 400");
  });
  it("maps network failure to a generic gateway error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("private URL or token")));
    await expect(client().queryTransaction("PAY-1")).rejects.toThrow("微信支付接口暂不可达");
  });
  it("disables provider access in mock mode", async () => {
    const local = new WechatPayClient({ get: () => "mock" } as never);
    await expect(local.queryTransaction("PAY-1")).rejects.toBeInstanceOf(NotFoundException);
  });
  it("validates signed bill metadata and downloads only the official origin", async () => {
    const bill = Buffer.from("sample bill");
    const hash = createHash("sha1").update(bill).digest("hex");
    const remote = vi.fn().mockResolvedValueOnce(response({ hash_type: "SHA1", hash_value: hash, download_url: "https://api.mch.weixin.qq.com/v3/billdownload/file?token=test" })).mockResolvedValueOnce(new Response(bill));
    vi.stubGlobal("fetch", remote);
    const metadata = await client().requestTradeBill("2026-10-02");
    expect(await client().downloadTradeBill(metadata)).toEqual(bill);
    expect(remote).toHaveBeenCalledTimes(2);
  });
  it("rejects mismatched bill hash", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("changed bill")));
    await expect(client().downloadTradeBill({ hashType: "SHA1", hashValue: "0".repeat(40), downloadUrl: "https://api.mch.weixin.qq.com/v3/billdownload/file?token=test" })).rejects.toBeInstanceOf(BadGatewayException);
  });
  it.each(["https://example.com/v3/billdownload/file", "https://api.mch.weixin.qq.com/other", "http://api.mch.weixin.qq.com/v3/billdownload/file"]) ("blocks an untrusted download URL %s", async (downloadUrl) => {
    const remote = vi.fn(); vi.stubGlobal("fetch", remote);
    await expect(client().downloadTradeBill({ hashType: "SHA1", hashValue: "0".repeat(40), downloadUrl })).rejects.toBeInstanceOf(BadRequestException);
    expect(remote).not.toHaveBeenCalled();
  });
  it("rejects impossible bill date", async () => {
    await expect(client().requestTradeBill("2026-02-30")).rejects.toBeInstanceOf(BadRequestException);
  });
  it("bounds response size", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("x".repeat(1_048_577))));
    await expect(client().queryTransaction("PAY-1")).rejects.toThrow("大小限制");
  });
  it("builds integer-fen refunds and rejects over-refund", () => {
    const input = { transactionId: "transaction-1", outRefundNo: "REFUND_1", refundFen: 10000, totalFen: 19800, reason: "预约取消" };
    expect(client().buildRefundRequest(input)).toMatchObject({ out_refund_no: "REFUND_1", amount: { refund: 10000, total: 19800, currency: "CNY" } });
    expect(() => client().buildRefundRequest({ ...input, refundFen: 19801 })).toThrow(BadRequestException);
  });
  it("keeps real refund submission disabled without any network request", async () => {
    const remote = vi.fn(); vi.stubGlobal("fetch", remote);
    const request = client().buildRefundRequest({ transactionId: "transaction-1", outRefundNo: "REFUND_1", refundFen: 19800, totalFen: 19800, reason: "预约取消" });
    await expect(client().submitRefund(request)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(remote).not.toHaveBeenCalled();
  });
});
