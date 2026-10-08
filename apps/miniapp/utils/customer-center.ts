import type { CustomerCenterOverview } from "@zydj/contracts";
import { api } from "./api";

const ORGANIZATION_STORAGE_KEY = "zydj.customer-center.organization-id";

export const getCustomerCenterOrganizationId = () => {
  const value = wx.getStorageSync(ORGANIZATION_STORAGE_KEY);
  return typeof value === "string" && value.trim() ? value : undefined;
};

export const rememberCustomerCenterOrganizationId = (
  organizationId: string,
) => {
  if (organizationId.trim())
    wx.setStorageSync(ORGANIZATION_STORAGE_KEY, organizationId);
};

export const customerCenterPath = (
  path = "/customer-center",
  params: Record<string, string | undefined> = {},
) => {
  const organizationId =
    params.organizationId ?? getCustomerCenterOrganizationId();
  const query = Object.entries({ ...params, organizationId })
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
    )
    .join("&");
  return query ? `${path}?${query}` : path;
};

export const loadCustomerCenterOverview = async () => {
  const overview = await api<CustomerCenterOverview>(customerCenterPath());
  rememberCustomerCenterOrganizationId(overview.organizationId);
  return overview;
};
