import type {
  AdminCustomerCenterSummary,
  CustomerCenterContent,
} from "@zydj/contracts";

export type CustomerCenterConfig = CustomerCenterContent;
export type CustomerCenterSummary = AdminCustomerCenterSummary;

export type CustomerCenterConfigDraft = {
  levelLabel: string;
  customerServicePhone: string | null;
  cityNewsTitle: string;
  cityNewsContent: string;
  appBannerTitle: string;
  appBannerSubtitle: string;
  appDownloadUrl: string | null;
  safeguardItems: string[];
};

export function customerCenterPaths(organizationId: string) {
  const prefix = `/admin/organizations/${encodeURIComponent(organizationId)}/customer-center`;
  return {
    config: `${prefix}/config`,
    summary: `${prefix}/summary`,
  } as const;
}

export function splitCustomerCenterLines(value: string) {
  return [
    ...new Set(
      value
        .split(/[\n，,]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

export function validateCustomerCenterConfig(draft: CustomerCenterConfigDraft) {
  const errors: string[] = [];
  if (!draft.levelLabel.trim()) errors.push("用户等级文案不能为空");
  if (
    draft.customerServicePhone &&
    !/^(?:400\d{7}|0\d{2,3}-?\d{7,8}|1\d{10})$/.test(
      draft.customerServicePhone.trim(),
    )
  ) {
    errors.push("客服电话格式无效");
  }
  if (!draft.cityNewsTitle.trim()) errors.push("城市快讯标题不能为空");
  if (!draft.cityNewsContent.trim()) errors.push("城市快讯内容不能为空");
  if (!draft.appBannerTitle.trim()) errors.push("APP 横幅标题不能为空");
  if (!draft.appBannerSubtitle.trim()) errors.push("APP 横幅说明不能为空");
  if (
    draft.appDownloadUrl &&
    !/^https:\/\/[^\s]+$/i.test(draft.appDownloadUrl.trim())
  ) {
    errors.push("APP 下载地址必须为 HTTPS 链接");
  }
  if (draft.safeguardItems.length === 0) {
    errors.push("至少填写一条服务保障文案");
  }
  if (draft.safeguardItems.length > 8) {
    errors.push("服务保障文案最多填写 8 条");
  }
  return errors;
}
