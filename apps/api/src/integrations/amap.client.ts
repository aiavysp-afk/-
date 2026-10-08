import {
  BadGatewayException,
  BadRequestException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { z } from "zod";
import type { AppEnv } from "../config/env.js";
import { readIntegrationJson } from "./integration-http.js";

const AMAP_ORIGIN = "https://restapi.amap.com";
const QUOTA_CODES = new Set(["10003", "10004", "10044", "10045"]);
const CONFIGURATION_CODES = new Set(["10001", "10002", "10009"]);

const AmapBase = z.object({
  status: z.string(),
  info: z.string().optional(),
  infocode: z.string().optional(),
});

const ReverseGeocodeResponse = AmapBase.extend({
  regeocode: z
    .object({
      formatted_address: z.string().min(1).max(300),
      addressComponent: z.object({
        adcode: z.string().regex(/^\d{6}$/),
        city: z.union([z.string(), z.array(z.unknown())]).optional(),
      }),
    })
    .optional(),
});

const GeocodeResponse = AmapBase.extend({
  geocodes: z
    .array(
      z.object({
        formatted_address: z.string().min(1).max(300),
        adcode: z.string().regex(/^\d{6}$/),
        location: z.string(),
      }),
    )
    .max(20)
    .optional(),
});

const InputTipsResponse = AmapBase.extend({
  tips: z
    .array(
      z.object({
        id: z.union([z.string(), z.array(z.unknown())]).optional(),
        name: z.string().min(1).max(200),
        address: z.union([z.string(), z.array(z.unknown())]).optional(),
        district: z.union([z.string(), z.array(z.unknown())]).optional(),
        adcode: z.union([z.string(), z.array(z.unknown())]).optional(),
        location: z.union([z.string(), z.array(z.unknown())]).optional(),
      }),
    )
    .max(100)
    .optional(),
});

const DrivingResponse = AmapBase.extend({
  route: z
    .object({
      paths: z.array(
        z.object({
          distance: z.string().regex(/^\d+$/),
          duration: z.string().regex(/^\d+$/),
        }),
      ),
    })
    .optional(),
});

type Coordinate = { latitude: number; longitude: number };

function coordinate(value: string) {
  const match = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(value);
  if (!match) return null;
  const longitude = Number(match[1]);
  const latitude = Number(match[2]);
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  )
    return null;
  return { latitude, longitude };
}

@Injectable()
export class AmapClient {
  constructor(private readonly config: ConfigService<AppEnv, true>) {}

  private assertEnabled() {
    if (
      this.config.get("MAP_PROVIDER", { infer: true }) !== "amap" ||
      this.config.get("MAP_GEOCODING_ENABLED", { infer: true }) !== "true"
    )
      throw new ServiceUnavailableException("高德地图服务尚未开启");
  }

  private async request(path: string, params: Record<string, string>) {
    this.assertEnabled();
    const key = this.config.get("AMAP_WEB_SERVICE_KEY", { infer: true });
    if (!/^[A-Fa-f0-9]{32}$/.test(key))
      throw new ServiceUnavailableException("高德地图服务尚未配置");
    const query = new URLSearchParams({ ...params, key, output: "JSON" });
    let raw: unknown;
    try {
      raw = await readIntegrationJson(
        await fetch(`${AMAP_ORIGIN}${path}?${query.toString()}`, {
          redirect: "error",
          signal: AbortSignal.timeout(8_000),
        }),
      );
    } catch {
      throw new BadGatewayException("高德地图服务暂时不可用");
    }
    const base = AmapBase.safeParse(raw);
    if (!base.success) throw new BadGatewayException("高德地图响应无效");
    if (base.data.status !== "1") {
      if (base.data.infocode && QUOTA_CODES.has(base.data.infocode))
        throw new HttpException("高德地图调用已达上限，请稍后重试", 429);
      if (base.data.infocode && CONFIGURATION_CODES.has(base.data.infocode))
        throw new ServiceUnavailableException(
          "高德地图 Key 平台配置不匹配，请联系管理员",
        );
      throw new BadGatewayException("高德地图服务返回错误");
    }
    return raw;
  }

  async reverseGeocode(input: Coordinate) {
    this.assertCoordinate(input);
    const parsed = ReverseGeocodeResponse.safeParse(
      await this.request("/v3/geocode/regeo", {
        location: this.pair(input),
        radius: "1000",
        extensions: "base",
      }),
    );
    if (!parsed.success || !parsed.data.regeocode)
      throw new BadGatewayException("高德地图逆解析响应无效");
    return {
      formattedAddress: parsed.data.regeocode.formatted_address,
      adcode: parsed.data.regeocode.addressComponent.adcode,
      latitude: input.latitude,
      longitude: input.longitude,
      coordinateSystem: "GCJ-02" as const,
    };
  }

  async geocode(input: { address: string; city: string }) {
    const address = input.address.trim();
    const city = input.city.trim();
    if (
      address.length < 5 ||
      address.length > 200 ||
      Buffer.byteLength(address) > 600 ||
      city.length < 2 ||
      city.length > 32 ||
      /[\x00-\x1f]/.test(address + city)
    )
      throw new BadRequestException("手动地址无效");
    const parsed = GeocodeResponse.safeParse(
      await this.request("/v3/geocode/geo", {
        address,
        city,
      }),
    );
    if (!parsed.success)
      throw new BadGatewayException("高德地图地址解析响应无效");
    const match = (parsed.data.geocodes ?? []).flatMap((item) => {
      const point = coordinate(item.location);
      return point ? [{ item, point }] : [];
    })[0];
    if (!match)
      throw new BadRequestException(
        "无法识别该手动地址，请补充区、道路、小区或改用高德定位",
      );
    return {
      detail: match.item.formatted_address,
      adcode: match.item.adcode,
      ...match.point,
      coordinateSystem: "GCJ-02" as const,
    };
  }

  async suggest(input: { keyword: string; city: string }) {
    const keyword = input.keyword.trim();
    const city = input.city.trim();
    if (
      keyword.length < 2 ||
      keyword.length > 32 ||
      Buffer.byteLength(keyword) > 96 ||
      city.length < 2 ||
      city.length > 32 ||
      /[\x00-\x1f]/.test(keyword + city)
    )
      throw new BadRequestException("地址关键词与服务城市无效");
    const parsed = InputTipsResponse.safeParse(
      await this.request("/v3/assistant/inputtips", {
        keywords: keyword,
        city,
        citylimit: "true",
        datatype: "poi",
      }),
    );
    if (!parsed.success)
      throw new BadGatewayException("高德地图地址提示响应无效");
    return (parsed.data.tips ?? [])
      .flatMap((tip, index) => {
        if (typeof tip.location !== "string") return [];
        const point = coordinate(tip.location);
        if (
          !point ||
          typeof tip.adcode !== "string" ||
          !/^\d{6}$/.test(tip.adcode)
        )
          return [];
        const id =
          typeof tip.id === "string" && tip.id
            ? tip.id
            : `${tip.adcode}-${index}`;
        const address = typeof tip.address === "string" ? tip.address : "";
        const district = typeof tip.district === "string" ? tip.district : city;
        return [
          {
            id,
            title: tip.name,
            address,
            city: district || city,
            adcode: tip.adcode,
            ...point,
            coordinateSystem: "GCJ-02" as const,
          },
        ];
      })
      .slice(0, 10);
  }

  async driving(input: { origin: Coordinate; destination: Coordinate }) {
    this.assertCoordinate(input.origin);
    this.assertCoordinate(input.destination);
    const parsed = DrivingResponse.safeParse(
      await this.request("/v3/direction/driving", {
        origin: this.pair(input.origin),
        destination: this.pair(input.destination),
        strategy: "0",
        extensions: "base",
      }),
    );
    const path = parsed.success ? parsed.data.route?.paths[0] : undefined;
    if (!path) throw new BadGatewayException("高德地图驾车路线响应无效");
    const distanceMeters = Number(path.distance);
    const durationSeconds = Number(path.duration);
    if (
      !Number.isSafeInteger(distanceMeters) ||
      !Number.isSafeInteger(durationSeconds)
    )
      throw new BadGatewayException("高德地图驾车路线响应无效");
    return { distanceMeters, durationSeconds };
  }

  private assertCoordinate(input: Coordinate) {
    if (
      !Number.isFinite(input.latitude) ||
      !Number.isFinite(input.longitude) ||
      input.latitude < -90 ||
      input.latitude > 90 ||
      input.longitude < -180 ||
      input.longitude > 180
    )
      throw new BadRequestException("定位坐标无效");
  }

  private pair(input: Coordinate) {
    return `${input.longitude.toFixed(6)},${input.latitude.toFixed(6)}`;
  }
}
