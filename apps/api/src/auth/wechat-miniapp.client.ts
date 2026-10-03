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

interface WechatCodeSessionResponse {
  openid?: string;
  unionid?: string;
  errcode?: number;
}

@Injectable()
export class WechatMiniappClient {
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
    const payload = (await response.json()) as WechatCodeSessionResponse;
    if (payload.errcode || !payload.openid) {
      throw new UnauthorizedException("微信登录凭证无效或已过期");
    }
    return { openId: payload.openid, unionId: payload.unionid };
  }
}
