import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AppEnv } from "../config/env.js";
import { encodeRpc } from "./aliyun-signature.js";
import { readIntegrationJson } from "./integration-http.js";

const Coordinates = z.object({
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
});
const Suggestions = z.object({
  status: z.literal(0),
  data: z
    .array(
      z.object({
        id: z.string().min(1).max(128),
        title: z.string().min(1).max(200),
        address: z.string().max(300),
        city: z.string().min(1).max(64),
        adcode: z
          .union([
            z.string().regex(/^\d{6}$/),
            z.number().int().min(100000).max(999999),
          ])
          .transform(String),
        type: z.number().int().min(0).max(4),
        location: Coordinates,
      }),
    )
    .max(10),
});
type TencentPath = "/ws/geocoder/v1/" | "/ws/place/v1/suggestion";
const LocationResult = z.object({
  status: z.literal(0),
  result: z.object({
    location: z.object({
      lat: z.number().finite().min(-90).max(90),
      lng: z.number().finite().min(-180).max(180),
    }),
    ad_info: z.object({ adcode: z.string().regex(/^\d{6}$/) }),
    reliability: z.number().int().min(0).max(10),
    level: z.number().int().min(0).max(11),
  }),
});
export function signTencentRequest(
  path: TencentPath,
  params: Record<string, string>,
  secret: string,
) {
  // Provider requires raw sorted values for signing, percent encoding only for sending.
  const keys = Object.keys(params).sort();
  const raw = keys.map((k) => `${k}=${params[k]}`).join("&");
  const signature = createHash("md5")
    .update(`${path}?${raw}${secret}`)
    .digest("hex");
  return `${keys.map((k) => `${encodeRpc(k)}=${encodeRpc(params[k]!)}`).join("&")}&sig=${signature}`;
}
export const signTencentGeocode = (
  params: Record<string, string>,
  secret: string,
) => signTencentRequest("/ws/geocoder/v1/", params, secret);

@Injectable()
export class TencentMapClient {
  constructor(private readonly config: ConfigService<AppEnv, true>) {}

  private assertEnabled() {
    if (
      this.config.get("MAP_PROVIDER", { infer: true }) !== "tencent" ||
      this.config.get("MAP_GEOCODING_ENABLED", { infer: true }) !== "true"
    )
      throw new ServiceUnavailableException("真实地图解析门禁未开启");
  }

  private async request(path: TencentPath, params: Record<string, string>) {
    this.assertEnabled();
    const key = this.config.get("TENCENT_MAP_KEY", { infer: true });
    const secret = this.config.get("TENCENT_MAP_SIGNING_SECRET", {
      infer: true,
    });
    if (!key.trim() || !secret.trim() || /[\r\n]/.test(key + secret))
      throw new ServiceUnavailableException("地图渠道配置未就绪");
    const query = signTencentRequest(
      path,
      { ...params, key, output: "json" },
      secret,
    );
    try {
      return await readIntegrationJson(
        await fetch(`https://apis.map.qq.com${path}?${query}`, {
          redirect: "error",
          signal: AbortSignal.timeout(8_000),
          headers: { "x-legacy-url-decode": "no" },
        }),
      );
    } catch {
      throw new BadGatewayException("地图渠道暂时不可用");
    }
  }

  // Internal primitive, not a public unmetered geocoding proxy or service-area decision.
  async geocode(input: { address: string; city: string }) {
    this.assertEnabled();
    const address = input.address.trim(),
      city = input.city.trim();
    if (
      address.length < 5 ||
      address.length > 200 ||
      city.length < 2 ||
      city.length > 32 ||
      /[\x00-\x1f]/.test(address + city)
    )
      throw new BadRequestException("地址与服务城市无效");
    const raw = await this.request("/ws/geocoder/v1/", {
      address,
      region: city,
      policy: "0",
    });
    const result = LocationResult.safeParse(raw);
    if (!result.success) throw new BadGatewayException("地图渠道响应无效");
    const { location, ad_info, reliability, level } = result.data.result;
    return {
      latitude: location.lat,
      longitude: location.lng,
      adcode: ad_info.adcode,
      coordinateSystem: "GCJ-02" as const,
      reliability,
      level,
      requiresManualConfirmation: reliability < 7 || level < 9,
    };
  }

  async suggest(input: { keyword: string; city: string }) {
    this.assertEnabled();
    const keyword = input.keyword.trim(),
      city = input.city.trim();
    if (
      keyword.length < 2 ||
      keyword.length > 32 ||
      Buffer.byteLength(keyword) > 96 ||
      city.length < 2 ||
      city.length > 32 ||
      /[\x00-\x1f]/.test(keyword + city)
    )
      throw new BadRequestException("地址关键词与服务城市无效");
    const parsed = Suggestions.safeParse(
      await this.request("/ws/place/v1/suggestion", {
        keyword,
        region: city,
        region_fix: "1",
        policy: "1",
        page_size: "10",
        page_index: "1",
      }),
    );
    if (!parsed.success) throw new BadGatewayException("地图渠道响应无效");
    return parsed.data.data
      .filter((poi) => poi.type === 0)
      .map((poi) => ({
        id: poi.id,
        title: poi.title,
        address: poi.address,
        city: poi.city,
        adcode: poi.adcode,
        latitude: poi.location.lat,
        longitude: poi.location.lng,
        coordinateSystem: "GCJ-02" as const,
      }));
  }
}
