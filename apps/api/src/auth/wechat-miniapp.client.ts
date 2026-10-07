import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";
import type { AppEnv } from "../config/env.js";

export interface WechatIdentityResult {
  openId: string;
  unionId?: string;
}

export interface WechatPhoneResult {
  phoneNumber: string;
}

interface WechatCodeSessionResponse {
  openid?: string;
  unionid?: string;
  errcode?: number;
}

interface WechatAccessTokenResponse {
  access_token?: string;
  expires_in?: number;
  errcode?: number;
}

interface WechatPhoneResponse {
  errcode?: number;
  phone_info?: {
    phoneNumber?: string;
    purePhoneNumber?: string;
    watermark?: { appid?: string };
  };
}

@Injectable()
export class WechatMiniappClient {
  private accessToken?: { value: string; expiresAt: number };

  constructor(private readonly config: ConfigService<AppEnv, true>) {}

  async exchangeCode(code: string): Promise<WechatIdentityResult> {
    if (this.config.get("AUTH_PROVIDER", { infer: true }) === "mock") {
      const suffix = createHash("sha256")
        .update(code)
        .digest("hex")
        .slice(0, 32);
      return { openId: `mock-${suffix}` };
    }

    const url = new URL("https://api.weixin.qq.com/sns/jscode2session");
    url.searchParams.set(
      "appid",
      this.config.get("WECHAT_MINIAPP_APP_ID", { infer: true }),
    );
    url.searchParams.set(
      "secret",
      this.config.get("WECHAT_MINIAPP_SECRET", { infer: true }),
    );
    url.searchParams.set("js_code", code);
    url.searchParams.set("grant_type", "authorization_code");

    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    } catch {
      throw new ServiceUnavailableException("微信登录服务暂时不可用");
    }

    if (!response.ok) {
      throw new ServiceUnavailableException("微信登录服务响应异常");
    }
    let payload: WechatCodeSessionResponse;
    try {
      payload = (await response.json()) as WechatCodeSessionResponse;
    } catch {
      throw new ServiceUnavailableException("微信登录服务响应格式异常");
    }
    if (
      !payload ||
      payload.errcode ||
      typeof payload.openid !== "string" ||
      !payload.openid ||
      payload.openid.length > 128 ||
      (payload.unionid !== undefined && typeof payload.unionid !== "string")
    ) {
      throw new UnauthorizedException("微信登录凭证无效或已过期");
    }
    return { openId: payload.openid, unionId: payload.unionid };
  }

  async exchangePhoneCode(code: string): Promise<WechatPhoneResult> {
    if (this.config.get("AUTH_PROVIDER", { infer: true }) === "mock") {
      return { phoneNumber: "13800138000" };
    }

    const accessToken = await this.getAccessToken();
    const url = new URL(
      "https://api.weixin.qq.com/wxa/business/getuserphonenumber",
    );
    url.searchParams.set("access_token", accessToken);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      throw new ServiceUnavailableException("微信手机号验证服务暂时不可用");
    }
    if (!response.ok) {
      throw new ServiceUnavailableException("微信手机号验证服务响应异常");
    }
    let payload: WechatPhoneResponse;
    try {
      payload = (await response.json()) as WechatPhoneResponse;
    } catch {
      throw new ServiceUnavailableException("微信手机号验证响应格式异常");
    }
    const phone =
      payload?.phone_info?.purePhoneNumber ?? payload?.phone_info?.phoneNumber;
    const appId = this.config.get("WECHAT_MINIAPP_APP_ID", { infer: true });
    const watermarkAppId = payload?.phone_info?.watermark?.appid;
    if (
      payload?.errcode ||
      typeof phone !== "string" ||
      !/^1[3-9]\d{9}$/.test(phone) ||
      (watermarkAppId !== undefined && watermarkAppId !== appId)
    ) {
      throw new UnauthorizedException("微信手机号授权无效或已过期");
    }
    return { phoneNumber: phone };
  }

  private async getAccessToken() {
    if (this.accessToken && this.accessToken.expiresAt > Date.now()) {
      return this.accessToken.value;
    }
    const url = new URL("https://api.weixin.qq.com/cgi-bin/token");
    url.searchParams.set("grant_type", "client_credential");
    url.searchParams.set(
      "appid",
      this.config.get("WECHAT_MINIAPP_APP_ID", { infer: true }),
    );
    url.searchParams.set(
      "secret",
      this.config.get("WECHAT_MINIAPP_SECRET", { infer: true }),
    );
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    } catch {
      throw new ServiceUnavailableException("微信手机号验证服务暂时不可用");
    }
    if (!response.ok) {
      throw new ServiceUnavailableException("微信手机号验证服务响应异常");
    }
    let payload: WechatAccessTokenResponse;
    try {
      payload = (await response.json()) as WechatAccessTokenResponse;
    } catch {
      throw new ServiceUnavailableException("微信手机号验证响应格式异常");
    }
    if (
      payload?.errcode ||
      typeof payload?.access_token !== "string" ||
      !payload.access_token ||
      typeof payload.expires_in !== "number"
    ) {
      throw new ServiceUnavailableException("微信手机号验证服务未就绪");
    }
    this.accessToken = {
      value: payload.access_token,
      expiresAt: Date.now() + Math.max(60, payload.expires_in - 60) * 1_000,
    };
    return this.accessToken.value;
  }
}
