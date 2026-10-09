import type { AdminStoredValueLedger, AuthUser } from "@zydj/contracts";

const financeRoles = new Set([
  "ADMIN",
  "FINANCE_REQUESTER",
  "FINANCE_APPROVER",
]);

export function financeOrganizationIds(user: AuthUser | null) {
  return [
    ...new Set(
      (user?.memberships ?? [])
        .filter((membership) => financeRoles.has(membership.role))
        .map((membership) => membership.organizationId),
    ),
  ];
}

export function canViewOrganizationWallet(
  user: AuthUser | null,
  organizationId: string,
) {
  return financeOrganizationIds(user).includes(organizationId);
}

export function storedValueLedgerPath(
  organizationId: string,
  customerId = "",
  limit = 50,
) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (customerId.trim()) query.set("customerId", customerId.trim());
  return `/admin/organizations/${encodeURIComponent(organizationId)}/customer-center/wallet-ledger?${query}`;
}

export const rechargeStatusLabels: Record<
  AdminStoredValueLedger["recharges"][number]["status"],
  string
> = {
  PENDING: "待付款确认",
  UNKNOWN: "支付结果未知，需核查",
  SUCCEEDED: "已确认充值到账",
  CLOSED: "已关闭，未入账",
};

export function storedValueTransactionLabel(type: string) {
  return (
    (
      { RECHARGE: "充值入账", FIRST_RECHARGE_REWARD: "首充红包入账" } as Record<
        string,
        string
      >
    )[type] ?? type
  );
}
