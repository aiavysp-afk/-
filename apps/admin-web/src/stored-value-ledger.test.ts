import type { AuthUser } from "@zydj/contracts";
import { describe, expect, it } from "vitest";
import {
  canViewOrganizationWallet,
  financeOrganizationIds,
  rechargeStatusLabels,
  storedValueLedgerPath,
  storedValueTransactionLabel,
} from "./stored-value-ledger";

const user = (memberships: AuthUser["memberships"]): AuthUser => ({
  id: "staff-1",
  displayName: "工作人员",
  phoneVerified: false,
  memberships,
});

describe("organization stored value visibility", () => {
  it("keeps ordinary operators and technicians out of sensitive wallets", () => {
    const ordinary = user([
      { organizationId: "org-1", role: "OPERATOR" },
      { organizationId: "org-2", role: "THERAPIST" },
      { organizationId: "org-3", role: "DISPATCHER" },
    ]);
    expect(financeOrganizationIds(ordinary)).toEqual([]);
    expect(canViewOrganizationWallet(ordinary, "org-1")).toBe(false);
    expect(canViewOrganizationWallet(null, "org-1")).toBe(false);
  });

  it("allows finance roles only within their own organizations", () => {
    const finance = user([
      { organizationId: "org-1", role: "FINANCE_REQUESTER" },
      { organizationId: "org-1", role: "FINANCE_APPROVER" },
      { organizationId: "org-2", role: "OPERATOR" },
      { organizationId: "org-3", role: "ADMIN" },
    ]);
    expect(financeOrganizationIds(finance)).toEqual(["org-1", "org-3"]);
    expect(canViewOrganizationWallet(finance, "org-2")).toBe(false);
  });

  it("encodes organization and customer IDs without broadening the query", () => {
    expect(storedValueLedgerPath("org/a", " customer&limit=100 ", 50)).toBe(
      "/admin/organizations/org%2Fa/customer-center/wallet-ledger?limit=50&customerId=customer%26limit%3D100",
    );
  });

  it("distinguishes reward credits and unconfirmed payments from credited recharges", () => {
    expect(storedValueTransactionLabel("FIRST_RECHARGE_REWARD")).toBe(
      "首充红包入账",
    );
    expect(storedValueTransactionLabel("RECHARGE")).toBe("充值入账");
    expect(rechargeStatusLabels.UNKNOWN).toContain("需核查");
    expect(rechargeStatusLabels.PENDING).toContain("待付款确认");
  });
});
