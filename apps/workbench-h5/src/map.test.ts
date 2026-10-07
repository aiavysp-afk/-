import { describe, expect, it } from "vitest";
import { buildAmapNavigationUrl, formatRoute, wgs84ToGcj02 } from "./map";

describe("technician map helpers", () => {
  it("converts Zhengzhou browser coordinates to GCJ-02", () => {
    const point = wgs84ToGcj02(34.7466, 113.6254);
    expect(point.coordinateSystem).toBe("GCJ-02");
    expect(point.latitude).not.toBe(34.7466);
    expect(point.longitude).not.toBe(113.6254);
  });

  it("builds an Amap navigation URI without an API key", () => {
    const url = new URL(
      buildAmapNavigationUrl({
        latitude: 34.75,
        longitude: 113.62,
        addressLabel: "郑州市测试地址",
      }),
    );
    expect(url.hostname).toBe("uri.amap.com");
    expect(url.searchParams.get("coordinate")).toBe("gaode");
    expect(url.searchParams.get("to")).toContain("113.620000,34.750000");
    expect(url.search).not.toContain("key=");
  });

  it("formats distance and ETA", () => {
    expect(formatRoute(2350, 721)).toBe("2.4 公里，预计 13 分钟");
  });
});
