import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigService } from "@nestjs/config";
import { WechatMiniappClient } from "./wechat-miniapp.client.js";
const client = (provider = "wechat") =>
  new WechatMiniappClient(
    new ConfigService({
      AUTH_PROVIDER: provider,
      WECHAT_MINIAPP_APP_ID: "wx-test",
      WECHAT_MINIAPP_SECRET: "test-placeholder-not-a-real-secret",
    }) as never,
  );
afterEach(() => vi.unstubAllGlobals());
describe("WeChat first-factor backend exchange", () => {
  it("calls only official code2Session and never returns app secret or session key", async () => {
    const fetcher = vi.fn(
      async (_url: URL) =>
        new Response(
          JSON.stringify({
            openid: "official-test-openid",
            session_key: "must-not-return",
          }),
        ),
    );
    vi.stubGlobal("fetch", fetcher);
    const r = await client().exchangeCode("test-code");
    const url = fetcher.mock.calls[0]![0] as unknown as URL;
    expect(url.origin + url.pathname).toBe(
      "https://api.weixin.qq.com/sns/jscode2session",
    );
    expect(url.searchParams.get("js_code")).toBe("test-code");
    expect(r).toEqual({ openId: "official-test-openid", unionId: undefined });
    expect(JSON.stringify(r)).not.toContain("must-not-return");
    expect(JSON.stringify(r)).not.toContain("test-placeholder");
  });
  it("mock mode does not contact WeChat", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect((await client("mock").exchangeCode("mock-code")).openId).toMatch(
      /^mock-/,
    );
    expect(f).not.toHaveBeenCalled();
  });
  it("rejects invalid or reused official code", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ errcode: 40029 })),
    );
    await expect(client().exchangeCode("used-code")).rejects.toMatchObject({
      status: 401,
    });
  });
  it("network failure does not disclose the credential-bearing URL", async () => {
    vi.stubGlobal("fetch", async () => {
      throw Error("sensitive upstream URL");
    });
    await expect(client().exchangeCode("code")).rejects.toThrow(
      "微信登录服务暂时不可用",
    );
  });
  it("rejects malformed JSON without passing parser details to callers", async () => {
    vi.stubGlobal("fetch", async () => new Response("not-json"));
    await expect(client().exchangeCode("code")).rejects.toMatchObject({
      status: 503,
    });
  });
  it("rejects null or non-string identities", async () => {
    for (const body of [null, { openid: 123 }, { openid: "a", unionid: 123 }]) {
      vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body)));
      await expect(client().exchangeCode("code")).rejects.toMatchObject({
        status: 401,
      });
    }
  });

  it("exchanges a one-time phone code through the official API", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "short-lived-token", expires_in: 7200 }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            phone_info: {
              purePhoneNumber: "13800138000",
              watermark: { appid: "wx-test" },
            },
          }),
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    const result = await client().exchangePhoneCode("phone-code");
    expect(result).toEqual({ phoneNumber: "13800138000" });
    const phoneRequest = fetcher.mock.calls[1] as unknown as [URL, RequestInit];
    expect(phoneRequest[0].origin + phoneRequest[0].pathname).toBe(
      "https://api.weixin.qq.com/wxa/business/getuserphonenumber",
    );
    expect(phoneRequest[1].body).toBe(JSON.stringify({ code: "phone-code" }));
  });

  it("uses a fixed local phone in mock mode without contacting WeChat", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(client("mock").exchangePhoneCode("code")).resolves.toEqual({
      phoneNumber: "13800138000",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects malformed phone results and mismatched watermark appids", async () => {
    for (const phoneBody of [
      { phone_info: { purePhoneNumber: "123" } },
      {
        phone_info: {
          purePhoneNumber: "13800138000",
          watermark: { appid: "wx-other" },
        },
      },
    ]) {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ access_token: "token", expires_in: 7200 }),
          ),
        )
        .mockResolvedValueOnce(new Response(JSON.stringify(phoneBody)));
      vi.stubGlobal("fetch", fetcher);
      await expect(client().exchangePhoneCode("code")).rejects.toMatchObject({
        status: 401,
      });
    }
  });
});
