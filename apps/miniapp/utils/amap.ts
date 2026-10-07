import type { AddressSuggestion, Gcj02Coordinate } from "@zydj/contracts";

const AMAP_ORIGIN = "https://restapi.amap.com";
const QUOTA_CODES = new Set(["10003", "10004", "10044", "10045"]);
const CONFIGURATION_CODES = new Set(["10001", "10002", "10009"]);

type AmapEnvelope = {
  status?: string;
  infocode?: string;
  regeocode?: {
    formatted_address?: string;
    addressComponent?: { adcode?: string };
  };
  tips?: Array<{
    id?: string | unknown[];
    name?: string;
    address?: string | unknown[];
    district?: string | unknown[];
    adcode?: string | unknown[];
    location?: string | unknown[];
  }>;
};

function failure(raw: AmapEnvelope) {
  if (raw.infocode && QUOTA_CODES.has(raw.infocode))
    return new Error("高德地图调用已达上限，请稍后重试");
  if (raw.infocode && CONFIGURATION_CODES.has(raw.infocode))
    return new Error("高德地图 Key 平台配置不匹配，请联系商家处理");
  return new Error("高德地图服务暂时不可用，请稍后重试");
}

function request(key: string, path: string, data: Record<string, string>) {
  if (!/^[A-Fa-f0-9]{32}$/.test(key))
    return Promise.reject(new Error("地图配置尚未就绪"));
  return new Promise<AmapEnvelope>((resolve, reject) =>
    wx.request<AmapEnvelope>({
      url: `${AMAP_ORIGIN}${path}`,
      method: "GET",
      // A WeChat Mini Program key is accepted by Amap only with the official
      // WXJS protocol metadata used by its mini-program integration.
      data: {
        ...data,
        key,
        output: "JSON",
        s: "rsx",
        platform: "WXJS",
        appname: key,
        sdkversion: "1.2.0",
        logversion: "2.0",
      },
      success(result) {
        const raw = result.data;
        if (result.statusCode !== 200 || raw?.status !== "1") {
          reject(failure(raw ?? {}));
          return;
        }
        resolve(raw);
      },
      fail() {
        reject(new Error("网络或高德地图服务异常，请稍后重试"));
      },
    }),
  );
}

export function getGcj02Location() {
  return new Promise<Gcj02Coordinate & { accuracyMeters?: number }>(
    (resolve, reject) =>
      wx.getLocation({
        type: "gcj02",
        isHighAccuracy: true,
        highAccuracyExpireTime: 5_000,
        success(result) {
          resolve({
            latitude: result.latitude,
            longitude: result.longitude,
            coordinateSystem: "GCJ-02",
            ...(Number.isFinite(result.accuracy)
              ? { accuracyMeters: result.accuracy }
              : {}),
          });
        },
        fail(error) {
          if (/auth|authorize|permission|deny/i.test(error.errMsg))
            reject(new Error("定位权限未开启，请在小程序设置中允许位置信息"));
          else reject(new Error("无法获取当前位置，请检查手机定位后重试"));
        },
      }),
  );
}

export async function reverseGeocode(key: string, point: Gcj02Coordinate) {
  const raw = await request(key, "/v3/geocode/regeo", {
    location: `${point.longitude.toFixed(6)},${point.latitude.toFixed(6)}`,
    radius: "1000",
    extensions: "base",
  });
  const detail = raw.regeocode?.formatted_address?.trim();
  const adcode = raw.regeocode?.addressComponent?.adcode;
  if (!detail || !adcode || !/^\d{6}$/.test(adcode))
    throw new Error("当前位置无法解析为中文地址，请改用搜索");
  return { detail: detail.slice(0, 200), adcode, ...point };
}

export async function suggestAddress(
  key: string,
  keyword: string,
  city: string,
): Promise<AddressSuggestion[]> {
  const raw = await request(key, "/v3/assistant/inputtips", {
    keywords: keyword,
    city,
    citylimit: "true",
    datatype: "poi",
  });
  return (raw.tips ?? [])
    .flatMap((tip, index) => {
      if (
        typeof tip.location !== "string" ||
        typeof tip.adcode !== "string" ||
        !/^\d{6}$/.test(tip.adcode) ||
        typeof tip.name !== "string"
      )
        return [];
      const match = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(tip.location);
      if (!match) return [];
      const longitude = Number(match[1]);
      const latitude = Number(match[2]);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
      return [
        {
          id:
            typeof tip.id === "string" && tip.id
              ? tip.id
              : `${tip.adcode}-${index}`,
          title: tip.name,
          address: typeof tip.address === "string" ? tip.address : "",
          city:
            typeof tip.district === "string" && tip.district
              ? tip.district
              : city,
          adcode: tip.adcode,
          latitude,
          longitude,
          coordinateSystem: "GCJ-02" as const,
        },
      ];
    })
    .slice(0, 10);
}
