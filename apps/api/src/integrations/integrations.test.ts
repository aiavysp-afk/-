import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";
import { validateEnv, type AppEnv } from "../config/env.js";
import { signAliyunRpc, encodeRpc } from "./aliyun-signature.js";
import { AliyunSmsClient } from "./aliyun-sms.client.js";
import { TencentMapClient, signTencentGeocode } from "./tencent-map.client.js";
import { readIntegrationJson } from "./integration-http.js";

const config = (overrides: Record<string, string | undefined> = {}) =>
  new ConfigService<AppEnv, true>(
    validateEnv({
      SMS_PROVIDER: "aliyun",
      SMS_SEND_ENABLED: "true",
      SAFETY_NOTIFICATION_RECEIPT_QUERY_ENABLED: "true",
      ALIYUN_SMS_ACCESS_KEY_ID: "test-id",
      ALIYUN_SMS_ACCESS_KEY_SECRET: "test-secret",
      ALIYUN_SMS_SIGN_NAME: "测试签名",
      ALIYUN_SMS_TEMPLATE_CODE: "SMS_test123",
      MAP_PROVIDER: "tencent",
      MAP_GEOCODING_ENABLED: "true",
      SERVICE_AREA_ADCODE_ALLOWLIST: "410102",
      TENCENT_MAP_KEY: "test-map-key",
      TENCENT_MAP_SIGNING_SECRET: "test-map-secret",
      ...overrides,
    }),
  );
const submission = {
  phone: "13800138000",
  parameters: { order: "TEST0001" },
  trackingId: "test-tracking",
};
const deliveryQuery = {
  phone: "13800138000",
  bizId: "test-biz^1",
  sendDate: "20261005",
  trackingId: "test-tracking",
};
const location = {
  status: 0,
  result: {
    location: { lat: 34.75, lng: 113.65 },
    ad_info: { adcode: "410102" },
    reliability: 8,
    level: 9,
  },
};
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => vi.unstubAllGlobals());

describe("channel signatures", () => {
  it("matches the Alibaba Cloud published ACS3 test vector without a live call", () => {
    const request = signAliyunRpc({
      host: "ecs.cn-shanghai.aliyuncs.com",
      action: "RunInstances",
      version: "2014-05-26",
      accessKeyId: "YourAccessKeyId",
      accessKeySecret: "YourAccessKeySecret",
      date: "2023-10-26T10:22:32Z",
      nonce: "3156853299f313e23d1673dc12e1703d",
      params: {
        RegionId: "cn-shanghai",
        ImageId: "win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd",
      },
    });
    expect(request.headers.authorization).toContain(
      "Signature=06563a9e1b43f5dfe96b81484da74bceab24a1d853912eee15083a6f0f3283c0",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("encodes RPC punctuation and signs STS credentials", () => {
    expect(encodeRpc(" a!*'()~")).toBe("%20a%21%2A%27%28%29~");
    const signed = signAliyunRpc({
      host: "dysmsapi.aliyuncs.com",
      action: "SendSms",
      version: "2017-05-25",
      accessKeyId: "test-id",
      accessKeySecret: "test-secret",
      securityToken: "test-token",
      date: "2026-10-04T00:00:00Z",
      nonce: "test-nonce",
      params: { SignName: "中原到家", PhoneNumbers: "13800138000" },
    });
    expect(signed.headers.authorization).toContain("x-acs-security-token");
    expect(signed.query).toMatch(/^PhoneNumbers=13800138000&SignName=%/);
  });
  it("rejects header injection before network submission", () => {
    expect(() =>
      signAliyunRpc({
        host: "dysmsapi.aliyuncs.com\ninvalid",
        action: "SendSms",
        version: "2017-05-25",
        accessKeyId: "test",
        accessKeySecret: "test",
        date: "test",
        nonce: "test",
        params: {},
      }),
    ).toThrow();
  });
  it("signs raw Tencent values while encoding the transmitted address exactly once", () => {
    const query = signTencentGeocode(
      { key: "test-key", address: "郑州市中原路1号&A座", region: "郑州" },
      "test-secret",
    );
    const expected = createHash("md5")
      .update(
        "/ws/geocoder/v1/?address=郑州市中原路1号&A座&key=test-key&region=郑州test-secret",
      )
      .digest("hex");
    const parsed = new URLSearchParams(query);
    expect(parsed.get("sig")).toBe(expected);
    expect(parsed.get("address")).toBe("郑州市中原路1号&A座");
    expect(parsed.size).toBe(4);
  });
});

describe("SMS internal submission", () => {
  it.each([{ SMS_SEND_ENABLED: "false" }, { SMS_PROVIDER: "mock" }])(
    "does not spend or fake success with gate %j",
    async (overrides) => {
      await expect(
        new AliyunSmsClient(config(overrides)).submit(submission),
      ).rejects.toThrow("门禁");
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("refuses missing credentials", async () => {
    await expect(
      new AliyunSmsClient(config({ ALIYUN_SMS_ACCESS_KEY_SECRET: "" })).submit(
        submission,
      ),
    ).rejects.toThrow("未就绪");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects batching and invalid tracking input", async () => {
    const client = new AliyunSmsClient(config());
    await expect(
      client.submit({ ...submission, phone: "13800138000,13900139000" }),
    ).rejects.toThrow("参数无效");
    await expect(
      client.submit({ ...submission, trackingId: "test\ninvalid" }),
    ).rejects.toThrow("参数无效");
    await expect(
      client.submit({ ...submission, parameters: { url: "test\ninvalid" } }),
    ).rejects.toThrow("变量无效");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("returns acceptance, not delivery, from signed fixed-host single-recipient submission", async () => {
    fetcher.mockResolvedValue(
      json({ Code: "OK", RequestId: "test-request", BizId: "test-biz" }),
    );
    expect(await new AliyunSmsClient(config()).submit(submission)).toEqual({
      status: "ACCEPTED",
      requestId: "test-request",
      bizId: "test-biz",
    });
    const [url, options] = fetcher.mock.calls[0]!;
    expect(new URL(url).hostname).toBe("dysmsapi.aliyuncs.com");
    expect(new URL(url).searchParams.get("TemplateCode")).toBe("SMS_test123");
    expect(options.method).toBe("POST");
    expect(options.redirect).toBe("error");
    expect(options.headers.authorization).toMatch(/^ACS3-HMAC-SHA256 /);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("recognizes provider rejection without returning raw error text", async () => {
    fetcher.mockResolvedValue(
      json({
        Code: "test-rejection",
        RequestId: "test-request",
        Message: "test-secret 13800138000",
      }),
    );
    expect(await new AliyunSmsClient(config()).submit(submission)).toEqual({
      status: "REJECTED",
    });
  });
  it("marks network failure UNKNOWN without retries or secret diagnostics", async () => {
    fetcher.mockRejectedValue(new Error("test-secret 13800138000"));
    expect(await new AliyunSmsClient(config()).submit(submission)).toEqual({
      status: "UNKNOWN",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([{}, { Code: "OK", RequestId: "test-request" }, null])(
    "marks malformed acceptance %j UNKNOWN",
    async (payload) => {
      fetcher.mockResolvedValue(json(payload));
      expect(await new AliyunSmsClient(config()).submit(submission)).toEqual({
        status: "UNKNOWN",
      });
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );
  it("does not follow redirects and treats HTTP errors as UNKNOWN", async () => {
    fetcher.mockResolvedValue(
      new Response("private-response", {
        status: 302,
        headers: { location: "https://example.test" },
      }),
    );
    expect(await new AliyunSmsClient(config()).submit(submission)).toEqual({
      status: "UNKNOWN",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("queries a single accepted message and records delivery without exposing content", async () => {
    fetcher.mockResolvedValue(
      json({
        Code: "OK",
        RequestId: "query-request",
        SmsSendDetailDTOs: {
          SmsSendDetailDTO: [
            {
              OutId: "test-tracking",
              SendStatus: 3,
              ErrCode: "DELIVERED",
              PhoneNum: "13800138000",
              Content: "private content",
            },
          ],
        },
      }),
    );
    expect(
      await new AliyunSmsClient(config()).queryDelivery(deliveryQuery),
    ).toEqual({ status: "DELIVERED" });
    const [url, options] = fetcher.mock.calls[0]!;
    const parsed = new URL(url);
    expect(parsed.hostname).toBe("dysmsapi.aliyuncs.com");
    expect(parsed.searchParams.get("BizId")).toBe("test-biz^1");
    expect(parsed.searchParams.get("PhoneNumber")).toBe("13800138000");
    expect(parsed.searchParams.get("SendDate")).toBe("20261005");
    expect(options.headers.authorization).toMatch(/^ACS3-HMAC-SHA256 /);
  });

  it.each([
    [1, { status: "PENDING" }],
    [2, { status: "FAILED", errorCode: "SMS_DELIVERY_ERROR_42" }],
  ])(
    "maps delivery status %s without returning message text",
    async (status, expected) => {
      fetcher.mockResolvedValue(
        json({
          Code: "OK",
          RequestId: "query-request",
          SmsSendDetailDTOs: {
            SmsSendDetailDTO: [
              {
                OutId: "test-tracking",
                SendStatus: status,
                ErrCode: status === 2 ? "error 42" : "",
              },
            ],
          },
        }),
      );
      expect(
        await new AliyunSmsClient(config()).queryDelivery(deliveryQuery),
      ).toEqual(expected);
    },
  );

  it("does not query with a closed receipt gate or malformed provider result", async () => {
    await expect(
      new AliyunSmsClient(
        config({ SAFETY_NOTIFICATION_RECEIPT_QUERY_ENABLED: "false" }),
      ).queryDelivery(deliveryQuery),
    ).rejects.toThrow("门禁");
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValue(json({ Code: "OK", RequestId: "query-request" }));
    expect(
      await new AliyunSmsClient(config()).queryDelivery(deliveryQuery),
    ).toEqual({ status: "PENDING" });
  });
});

describe("Tencent geocoding primitive", () => {
  it("supports signed server-side address suggestions restricted to the selected city", async () => {
    fetcher.mockResolvedValue(
      json({
        status: 0,
        data: [
          {
            id: "test-poi",
            title: "测试楼宇",
            address: "测试地址",
            city: "郑州市",
            adcode: 410102,
            type: 0,
            location: { lat: 34.75, lng: 113.65 },
          },
          {
            id: "test-bus",
            title: "测试线路",
            address: "测试地址",
            city: "郑州市",
            adcode: 410102,
            type: 3,
            location: { lat: 34.75, lng: 113.65 },
          },
        ],
      }),
    );
    const result = await new TencentMapClient(config()).suggest({
      keyword: "中原",
      city: "郑州市",
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.adcode).toBe("410102");
    const [url] = fetcher.mock.calls[0]!;
    const target = new URL(url);
    expect(target.pathname).toBe("/ws/place/v1/suggestion");
    expect(target.searchParams.get("region_fix")).toBe("1");
    expect(target.searchParams.get("output")).toBe("json");
    expect(target.searchParams.get("policy")).toBe("1");
    expect(target.searchParams.has("callback")).toBe(false);
  });
  it("rejects invalid suggestion input and oversized provider results", async () => {
    const client = new TencentMapClient(config());
    await expect(
      client.suggest({ keyword: "", city: "郑州市" }),
    ).rejects.toThrow("无效");
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValue(
      json({
        status: 0,
        data: Array.from({ length: 11 }, () => ({
          id: "test-poi",
          title: "test",
          address: "test",
          city: "郑州市",
          adcode: 410102,
          type: 0,
          location: { lat: 34.75, lng: 113.65 },
        })),
      }),
    );
    await expect(
      client.suggest({ keyword: "中原", city: "郑州市" }),
    ).rejects.toThrow("响应无效");
  });
  it("blocks calls when the runtime gate is off", async () => {
    await expect(
      new TencentMapClient(config({ MAP_GEOCODING_ENABLED: "false" })).geocode({
        address: "郑州市中原路1号",
        city: "郑州市",
      }),
    ).rejects.toThrow("门禁");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails startup when an enabled map gate has the wrong provider", () => {
    expect(() => config({ MAP_PROVIDER: "mock" })).toThrow("MAP_PROVIDER");
  });

  it("blocks missing SK and invalid city/address", async () => {
    expect(() => config({ TENCENT_MAP_SIGNING_SECRET: "" })).toThrow(
      "TENCENT_MAP_SIGNING_SECRET",
    );
    await expect(
      new TencentMapClient(config()).geocode({
        address: "郑州市中原路1号",
        city: "",
      }),
    ).rejects.toThrow("无效");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("uses signed fixed-host requests and returns only normalized GCJ-02 coordinates", async () => {
    fetcher.mockResolvedValue(json(location));
    expect(
      await new TencentMapClient(config()).geocode({
        address: "郑州市中原路1号&A座",
        city: "郑州市",
      }),
    ).toEqual({
      latitude: 34.75,
      longitude: 113.65,
      adcode: "410102",
      coordinateSystem: "GCJ-02",
      reliability: 8,
      level: 9,
      requiresManualConfirmation: false,
    });
    const [url, options] = fetcher.mock.calls[0]!;
    expect(new URL(url).hostname).toBe("apis.map.qq.com");
    expect(new URL(url).searchParams.get("region")).toBe("郑州市");
    expect(new URL(url).searchParams.has("sig")).toBe(true);
    expect(options.headers["x-legacy-url-decode"]).toBe("no");
    expect(options.redirect).toBe("error");
  });
  it("flags low-precision results instead of silently qualifying a service address", async () => {
    fetcher.mockResolvedValue(
      json({ ...location, result: { ...location.result, level: 7 } }),
    );
    expect(
      (
        await new TencentMapClient(config()).geocode({
          address: "郑州市中原路1号",
          city: "郑州市",
        })
      ).requiresManualConfirmation,
    ).toBe(true);
  });
  it.each([
    null,
    { status: 112, message: "private-provider-error" },
    {
      ...location,
      result: { ...location.result, location: { lat: 190, lng: 113 } },
    },
  ])("rejects malformed/failing provider result %j", async (payload) => {
    fetcher.mockResolvedValue(json(payload));
    await expect(
      new TencentMapClient(config()).geocode({
        address: "郑州市中原路1号",
        city: "郑州市",
      }),
    ).rejects.toThrow("响应无效");
  });
  it("sanitizes transport errors and never retries automatically", async () => {
    fetcher.mockRejectedValue(new Error("test-map-secret private-address"));
    await expect(
      new TencentMapClient(config()).geocode({
        address: "郑州市中原路1号",
        city: "郑州市",
      }),
    ).rejects.toThrow("地图渠道暂时不可用");
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe("integration response bounds", () => {
  it("rejects HTML and invalid JSON", async () => {
    await expect(
      readIntegrationJson(
        new Response("<html>error</html>", {
          headers: { "content-type": "text/html" },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      readIntegrationJson(
        new Response("invalid", {
          headers: { "content-type": "application/json" },
        }),
      ),
    ).rejects.toThrow();
  });
  it("rejects large advertised and streamed payloads", async () => {
    await expect(
      readIntegrationJson(
        new Response("{}", {
          headers: {
            "content-type": "application/json",
            "content-length": "999999",
          },
        }),
      ),
    ).rejects.toThrow("too large");
    await expect(
      readIntegrationJson(json({ payload: "x".repeat(65_536) })),
    ).rejects.toThrow("too large");
  });
});
