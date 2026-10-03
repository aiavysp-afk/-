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
});
