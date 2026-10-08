import { describe, expect, it } from "vitest";
import {
  customerCenterPaths,
  splitCustomerCenterLines,
  validateCustomerCenterConfig,
  type CustomerCenterConfigDraft,
} from "./customer-center";

const validDraft: CustomerCenterConfigDraft = {
  levelLabel: "中原到家用户",
  customerServicePhone: null,
  cityNewsTitle: "郑州服务动态",
  cityNewsContent: "服务范围与营业时间以客户端实时展示为准",
  appBannerTitle: "中原到家官方服务",
  appBannerSubtitle: "当前可直接在微信小程序预约",
  appDownloadUrl: null,
  safeguardItems: ["价格透明", "服务保障", "售后支持"],
};

describe("customer center admin helpers", () => {
  it("builds organization-scoped customer center endpoints", () => {
    expect(customerCenterPaths("org/a")).toEqual({
      config: "/admin/organizations/org%2Fa/customer-center/config",
      summary: "/admin/organizations/org%2Fa/customer-center/summary",
    });
  });

  it("normalizes and deduplicates safeguard copy", () => {
    expect(splitCustomerCenterLines("价格透明\n服务保障，价格透明")).toEqual([
      "价格透明",
      "服务保障",
    ]);
  });

  it("accepts an intentionally absent app download link", () => {
    expect(validateCustomerCenterConfig(validDraft)).toEqual([]);
  });

  it("rejects non-HTTPS download links and incomplete content", () => {
    expect(
      validateCustomerCenterConfig({
        ...validDraft,
        customerServicePhone: "400-000-0000",
        cityNewsTitle: "",
        appDownloadUrl: "http://example.com/app",
        safeguardItems: [],
      }),
    ).toEqual([
      "客服电话格式无效",
      "城市快讯标题不能为空",
      "APP 下载地址必须为 HTTPS 链接",
      "至少填写一条服务保障文案",
    ]);
  });
});
