import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";
import type { AppEnv } from "../config/env.js";
import type { WechatIdentityResult } from "./wechat-miniapp.client.js";

type OauthTokenResponse = {
  access_token?: string;
  openid?: string;
  unionid?: string;
  errcode?: number;
};

type OauthUserInfoResponse = {
  openid?: string;
  unionid?: string;
  errcode?: number;
};

@Injectable()
export class WechatH5Client {
  constructor(private readonly config: ConfigService<AppEnv, true>) {}

  authorizeUrl(state: string) {
    this.assertEnabled();
    const url = new URL("https://open.weixin.qq.com/connect/oauth2/authorize");
    url.searchParams.set(
      "appid",
      this.config.get("TECHNICIAN_H5_APP_ID", { infer: true }),
    );
    url.searchParams.set(
      "redirect_uri",
      this.config.get("TECHNICIAN_H5_OAUTH_CALLBACK_URL", { infer: true }),
    );
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "snsapi_userinfo");
    url.searchParams.set("state", state);
    return `${url.toString()}#wechat_redirect`;
  }

  async exchangeOauthCode(code: string): Promise<WechatIdentityResult> {
    this.assertEnabled();
    if (this.config.get("AUTH_PROVIDER", { infer: true }) === "mock") {
      const suffix = createHash("sha256").update(code).digest("hex").slice(0, 32);
      return { openId: `h5-mock-${suffix}`, unionId: `h5-union-${suffix}` };
    }

    const tokenUrl = new URL("https://api.weixin.qq.com/sns/oauth2/access_token");
    tokenUrl.searchParams.set(
      "appid",
      this.config.get("TECHNICIAN_H5_APP_ID", { infer: true }),
    );
    tokenUrl.searchParams.set(
      "secret",
      this.config.get("TECHNICIAN_H5_APP_SECRET", { infer: true }),
    );
    tokenUrl.searchParams.set("code", code);
    tokenUrl.searchParams.set("grant_type", "authorization_code");
    const token = await this.getJson<OauthTokenResponse>(tokenUrl);
    if (
      token.errcode ||
      !validWechatId(token.openid) ||
      typeof token.access_token !== "string" ||
      token.access_token.length < 16 ||
      token.access_token.length > 512
    ) {
      throw new UnauthorizedException("微信H5授权凭证无效或已过期");
    }

    let unionId = token.unionid;
    if (!validWechatId(unionId)) {
      const infoUrl = new URL("https://api.weixin.qq.com/sns/userinfo");
      infoUrl.searchParams.set("access_token", token.access_token);
      infoUrl.searchParams.set("openid", token.openid);
      infoUrl.searchParams.set("lang", "zh_CN");
      const info = await this.getJson<OauthUserInfoResponse>(infoUrl);
      if (info.errcode || info.openid !== token.openid) {
        throw new UnauthorizedException("微信H5用户信息校验失败");
      }
      unionId = info.unionid;
    }
    if (!validWechatId(unionId)) {
      throw new UnauthorizedException(
        "未获取到UnionID，请确认公众号与小程序已绑定同一微信开放平台",
      );
    }
    return { openId: token.openid, unionId };
  }

  private async getJson<T>(url: URL): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    } catch {
      throw new ServiceUnavailableException("微信H5授权服务暂时不可用");
    }
    if (!response.ok) {
      throw new ServiceUnavailableException("微信H5授权服务响应异常");
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new ServiceUnavailableException("微信H5授权响应格式异常");
    }
  }

  private assertEnabled() {
    if (
      this.config.get("TECHNICIAN_H5_ONBOARDING_ENABLED", { infer: true }) !==
      "true"
    ) {
      throw configurationNotReady("技师H5入驻通道尚未开放");
    }
    const appId = this.config.get("TECHNICIAN_H5_APP_ID", { infer: true });
    const appSecret = this.config.get("TECHNICIAN_H5_APP_SECRET", {
      infer: true,
    });
    const callback = this.config.get("TECHNICIAN_H5_OAUTH_CALLBACK_URL", {
      infer: true,
    });
    let validCallback = false;
    try {
      const url = new URL(callback);
      validCallback =
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === "/v1/technician/h5-onboarding/wechat/callback";
    } catch {
      validCallback = false;
    }
    if (
      !/^wx[A-Za-z0-9]{16}$/.test(appId) ||
      !appSecret ||
      /[\r\n]/.test(appSecret) ||
      !validCallback
    ) {
      throw configurationNotReady("微信公众号网页授权配置未就绪");
    }
  }
}

const validWechatId = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 6 && value.length <= 128;

const configurationNotReady = (message: string) =>
  new ServiceUnavailableException({
    statusCode: 503,
    code: "CONFIGURATION_NOT_READY",
    message,
  });
