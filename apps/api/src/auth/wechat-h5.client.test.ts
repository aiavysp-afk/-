import { ConfigService } from "@nestjs/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../config/env.js";
import { WechatH5Client } from "./wechat-h5.client.js";

const client = (values: Record<string, string>) =>
  new WechatH5Client(
    new ConfigService({
      TECHNICIAN_H5_ONBOARDING_ENABLED: "true",
      TECHNICIAN_H5_APP_ID: "wx1234567890abcdef",
      TECHNICIAN_H5_APP_SECRET: "secret",
      TECHNICIAN_H5_OAUTH_CALLBACK_URL:
        "https://api.mtsc.top/v1/technician/h5-onboarding/wechat/callback",
      AUTH_PROVIDER: "wechat",
      ...values,
    }) as ConfigService<AppEnv, true>,
  );

afterEach(() => vi.unstubAllGlobals());

describe("WechatH5Client", () => {
  it("returns CONFIGURATION_NOT_READY while the production feature gate is closed", () => {
    const disabled = client({ TECHNICIAN_H5_ONBOARDING_ENABLED: "false" });
    try {
      disabled.authorizeUrl("state");
      throw new Error("expected authorizeUrl to fail");
    } catch (error) {
      expect(error).toMatchObject({
        response: expect.objectContaining({
          code: "CONFIGURATION_NOT_READY",
        }),
      });
    }
  });

  it("returns CONFIGURATION_NOT_READY when enabled without verified OAuth credentials", () => {
    const incomplete = client({ TECHNICIAN_H5_APP_SECRET: "" });
    try {
      incomplete.authorizeUrl("state");
      throw new Error("expected authorizeUrl to fail");
    } catch (error) {
      expect(error).toMatchObject({
        response: expect.objectContaining({
          code: "CONFIGURATION_NOT_READY",
        }),
      });
    }
  });

  it("never falls back to openid when WeChat supplies no UnionID", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "a".repeat(32),
            openid: "openid-value",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ openid: "openid-value" }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(client({}).exchangeOauthCode("oauth-code")).rejects.toThrow(
      "未获取到UnionID",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses snsapi_userinfo and the fixed server callback", () => {
    const url = new URL(
      client({}).authorizeUrl("opaque-state").replace(/#wechat_redirect$/, ""),
    );
    expect(url.searchParams.get("scope")).toBe("snsapi_userinfo");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://api.mtsc.top/v1/technician/h5-onboarding/wechat/callback",
    );
    expect(url.searchParams.get("state")).toBe("opaque-state");
  });
});
