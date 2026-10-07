import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { ConfigService } from "@nestjs/config";
import { validateEnv, type AppEnv } from "../config/env.js";
import { signAliyunRpc, encodeRpc } from "./aliyun-signature.js";
import { AliyunSmsClient } from "./aliyun-sms.client.js";
import { AmapClient } from "./amap.client.js";
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
      MAP_PROVIDER: "amap",
      MAP_GEOCODING_ENABLED: "true",
      SERVICE_AREA_ADCODE_ALLOWLIST: "410102",
      AMAP_MINIAPP_KEY: "a".repeat(32),
      AMAP_WEB_SERVICE_KEY: "b".repeat(32),
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

describe("Amap integration primitives", () => {
  it("supports fixed-host POI suggestions restricted to the selected city", async () => {
    fetcher.mockResolvedValue(
      json({
        status: "1",
        info: "OK",
        infocode: "10000",
        tips: [
          {
            id: "test-poi",
            name: "测试楼宇",
            address: "测试地址",
            district: "郑州市中原区",
            adcode: "410102",
            location: "113.65,34.75",
          },
        ],
      }),
    );
    const result = await new AmapClient(config()).suggest({
      keyword: "中原",
      city: "郑州市",
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.adcode).toBe("410102");
    const [url] = fetcher.mock.calls[0]!;
    const target = new URL(url);
    expect(target.hostname).toBe("restapi.amap.com");
    expect(target.pathname).toBe("/v3/assistant/inputtips");
    expect(target.searchParams.get("citylimit")).toBe("true");
    expect(target.searchParams.get("datatype")).toBe("poi");
  });
  it("rejects invalid suggestion input", async () => {
    const client = new AmapClient(config());
    await expect(
      client.suggest({ keyword: "", city: "郑州市" }),
    ).rejects.toThrow("无效");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("blocks calls when the runtime gate is off", async () => {
    await expect(
      new AmapClient(config({ MAP_GEOCODING_ENABLED: "false" })).reverseGeocode(
        {
          latitude: 34.75,
          longitude: 113.65,
        },
      ),
    ).rejects.toThrow("尚未开启");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails startup when an enabled map gate has the wrong provider", () => {
    expect(() => config({ MAP_PROVIDER: "mock" })).toThrow("MAP_PROVIDER");
  });

  it("blocks missing Web Service key and invalid coordinates", async () => {
    expect(() => config({ AMAP_WEB_SERVICE_KEY: "" })).toThrow(
      "AMAP_WEB_SERVICE_KEY",
    );
    await expect(
      new AmapClient(config()).reverseGeocode({
        latitude: 190,
        longitude: 113.65,
      }),
    ).rejects.toThrow("坐标无效");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("reverse-geocodes GCJ-02 coordinates on the fixed Amap host", async () => {
    fetcher.mockResolvedValue(
      json({
        status: "1",
        info: "OK",
        infocode: "10000",
        regeocode: {
          formatted_address: "河南省郑州市中原区测试路1号",
          addressComponent: { adcode: "410102", city: "郑州市" },
        },
      }),
    );
    expect(
      await new AmapClient(config()).reverseGeocode({
        latitude: 34.75,
        longitude: 113.65,
      }),
    ).toEqual({
      formattedAddress: "河南省郑州市中原区测试路1号",
      latitude: 34.75,
      longitude: 113.65,
      adcode: "410102",
      coordinateSystem: "GCJ-02",
    });
    const [url, options] = fetcher.mock.calls[0]!;
    expect(new URL(url).hostname).toBe("restapi.amap.com");
    expect(new URL(url).pathname).toBe("/v3/geocode/regeo");
    expect(new URL(url).searchParams.get("location")).toBe(
      "113.650000,34.750000",
    );
    expect(options.redirect).toBe("error");
  });
  it("returns driving distance/duration and maps quota errors", async () => {
    fetcher.mockResolvedValueOnce(
      json({
        status: "1",
        info: "OK",
        infocode: "10000",
        route: { paths: [{ distance: "5200", duration: "900" }] },
      }),
    );
    await expect(
      new AmapClient(config()).driving({
        origin: { latitude: 34.75, longitude: 113.65 },
        destination: { latitude: 34.8, longitude: 113.7 },
      }),
    ).resolves.toEqual({ distanceMeters: 5200, durationSeconds: 900 });
    fetcher.mockResolvedValueOnce(
      json({ status: "0", info: "LIMIT", infocode: "10003" }),
    );
    await expect(
      new AmapClient(config()).driving({
        origin: { latitude: 34.75, longitude: 113.65 },
        destination: { latitude: 34.8, longitude: 113.7 },
      }),
    ).rejects.toThrow("已达上限");
    fetcher.mockResolvedValueOnce(
      json({ status: "0", info: "PLATFORM", infocode: "10009" }),
    );
    await expect(
      new AmapClient(config()).driving({
        origin: { latitude: 34.75, longitude: 113.65 },
        destination: { latitude: 34.8, longitude: 113.7 },
      }),
    ).rejects.toThrow("Key 平台配置不匹配");
  });
  it("sanitizes transport errors and never retries automatically", async () => {
    fetcher.mockRejectedValue(new Error("private-key private-address"));
    await expect(
      new AmapClient(config()).reverseGeocode({
        latitude: 34.75,
        longitude: 113.65,
      }),
    ).rejects.toThrow("高德地图服务暂时不可用");
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
