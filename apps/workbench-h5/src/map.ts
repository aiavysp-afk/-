import type { Gcj02Coordinate } from "@zydj/contracts";

const PI = Math.PI;
const A = 6378245.0;
const EE = 0.006693421622965943;

function outOfChina(latitude: number, longitude: number) {
  return (
    longitude < 72.004 ||
    longitude > 137.8347 ||
    latitude < 0.8293 ||
    latitude > 55.8271
  );
}

function transformLatitude(x: number, y: number) {
  let value =
    -100 +
    2 * x +
    3 * y +
    0.2 * y * y +
    0.1 * x * y +
    0.2 * Math.sqrt(Math.abs(x));
  value += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
  value += ((20 * Math.sin(y * PI) + 40 * Math.sin((y / 3) * PI)) * 2) / 3;
  value +=
    ((160 * Math.sin((y / 12) * PI) + 320 * Math.sin((y * PI) / 30)) * 2) / 3;
  return value;
}

function transformLongitude(x: number, y: number) {
  let value =
    300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  value += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
  value += ((20 * Math.sin(x * PI) + 40 * Math.sin((x / 3) * PI)) * 2) / 3;
  value +=
    ((150 * Math.sin((x / 12) * PI) + 300 * Math.sin((x / 30) * PI)) * 2) / 3;
  return value;
}

export function wgs84ToGcj02(
  latitude: number,
  longitude: number,
): Gcj02Coordinate {
  if (outOfChina(latitude, longitude))
    return { latitude, longitude, coordinateSystem: "GCJ-02" };
  let dLatitude = transformLatitude(longitude - 105, latitude - 35);
  let dLongitude = transformLongitude(longitude - 105, latitude - 35);
  const radians = (latitude / 180) * PI;
  let magic = Math.sin(radians);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLatitude = (dLatitude * 180) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
  dLongitude = (dLongitude * 180) / ((A / sqrtMagic) * Math.cos(radians) * PI);
  return {
    latitude: latitude + dLatitude,
    longitude: longitude + dLongitude,
    coordinateSystem: "GCJ-02",
  };
}

export function getBrowserGcj02Location() {
  if (!window.isSecureContext || !navigator.geolocation)
    return Promise.reject(
      new Error("位置上报需要 HTTPS 安全页面并允许浏览器定位"),
    );
  return new Promise<Gcj02Coordinate & { accuracyMeters: number }>(
    (resolve, reject) =>
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const converted = wgs84ToGcj02(
            position.coords.latitude,
            position.coords.longitude,
          );
          resolve({ ...converted, accuracyMeters: position.coords.accuracy });
        },
        (error) => {
          if (error.code === error.PERMISSION_DENIED)
            reject(new Error("定位权限已拒绝，请在浏览器设置中允许位置后重试"));
          else if (error.code === error.TIMEOUT)
            reject(new Error("定位超时，请到开阔处后重试"));
          else reject(new Error("无法获取当前位置，请检查定位服务"));
        },
        { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
      ),
  );
}

export function buildAmapNavigationUrl(input: {
  latitude: number;
  longitude: number;
  addressLabel: string;
}) {
  const query = new URLSearchParams({
    to: `${input.longitude.toFixed(6)},${input.latitude.toFixed(6)},${input.addressLabel}`,
    mode: "car",
    policy: "1",
    src: "中原到家技师端",
    coordinate: "gaode",
    callnative: "1",
  });
  return `https://uri.amap.com/navigation?${query.toString()}`;
}

export function formatRoute(distanceMeters: number, durationSeconds: number) {
  const distance =
    distanceMeters >= 1000
      ? `${(distanceMeters / 1000).toFixed(1)} 公里`
      : `${distanceMeters} 米`;
  const minutes = Math.max(1, Math.ceil(durationSeconds / 60));
  return `${distance}，预计 ${minutes} 分钟`;
}
