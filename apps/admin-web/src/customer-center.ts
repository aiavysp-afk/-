import {
  AdminCustomerPhoneRevealRequestSchema,
  type AdminCustomerCenterSummary,
  type AdminCustomerDirectory,
  type AdminCustomerPhoneReveal,
  type CustomerCenterContent,
} from "@zydj/contracts";

export type CustomerCenterConfig = CustomerCenterContent;
export type CustomerCenterSummary = AdminCustomerCenterSummary;

export type CustomerDirectoryItem = AdminCustomerDirectory["items"][number];
export type CustomerDirectoryPage = AdminCustomerDirectory;
export type CustomerPhoneDisclosure = AdminCustomerPhoneReveal;

export function customerDirectoryPaths(organizationId: string) {
  const prefix = `/admin/organizations/${encodeURIComponent(organizationId)}/customer-center/customers`;
  return {
    list: (cursor?: string | null) =>
      `${prefix}?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    revealPhone: (customerId: string) =>
      `${prefix}/${encodeURIComponent(customerId)}/reveal-phone`,
  };
}

export function customerDirectoryError(status: number) {
  if (status === 401) return "登录已过期，请重新登录。";
  if (status === 403) {
    return "当前操作未获授权；查看完整号码前，请先在账户安全完成动态码验证。";
  }
  if (status === 404) return "未找到当前组织关联客户或已验证的手机号。";
  if (status === 429) return "请求过于频繁，请稍后重试。";
  return "客户资料暂时无法读取，请稍后重试。";
}

export function validCustomerPhoneReason(reason: string) {
  return AdminCustomerPhoneRevealRequestSchema.safeParse({ reason }).success;
}

export function safeCustomerMaskedPhone(phone: string | null) {
  return phone && /^1\d{2}\*{4}\d{4}$/.test(phone) ? phone : "未展示号码";
}

/** A disclosure is deliberately ephemeral and invalidated even if a fetch ignores abort. */
export function createCustomerPhoneDisclosure(
  onChange: (value: CustomerPhoneDisclosure | null) => void,
) {
  let generation = 0;
  let disposed = false;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clear() {
    generation += 1;
    controller?.abort();
    controller = null;
    if (timer) clearTimeout(timer);
    timer = null;
    if (!disposed) onChange(null);
  }

  return {
    clear,
    begin(userId: string) {
      clear();
      controller = new AbortController();
      const currentGeneration = generation;
      const signal = controller.signal;
      return {
        userId,
        signal,
        isCurrent: () =>
          !disposed && !signal.aborted && generation === currentGeneration,
      };
    },
    show(
      ticket: { userId: string; isCurrent: () => boolean },
      value: CustomerPhoneDisclosure,
      now = Date.now(),
    ) {
      const duration = Math.min(Date.parse(value.expiresAt) - now, 60_000);
      if (
        !ticket.isCurrent() ||
        value.userId !== ticket.userId ||
        !/^1[3-9]\d{9}$/.test(value.phone) ||
        !Number.isFinite(duration) ||
        duration <= 0
      ) {
        return false;
      }
      onChange({
        userId: value.userId,
        phone: value.phone,
        expiresAt: new Date(now + duration).toISOString(),
      });
      timer = setTimeout(clear, duration);
      return true;
    },
    dispose() {
      disposed = true;
      clear();
    },
  };
}

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
