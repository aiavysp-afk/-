import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AuthUser } from "@zydj/contracts";
import { StoredValueLedgerWorkspace } from "./stored-value-ledger-workspace";

describe("stored value finance gate", () => {
  it.each(["OPERATOR", "THERAPIST", "DISPATCHER"] as const)(
    "renders no wallet query controls for %s",
    (role) => {
      const user: AuthUser = {
        id: "staff-1",
        displayName: "工作人员",
        phoneVerified: false,
        memberships: [{ organizationId: "org-1", role }],
      };
      const html = renderToStaticMarkup(
        <StoredValueLedgerWorkspace
          token="session"
          user={user}
          preferredOrganizationId="org-1"
        />,
      );
      expect(html).toContain("身份验证后才能读取储值账本");
      expect(html).not.toContain("wallet-ledger-filters");
      expect(html).not.toContain("客户用户 ID");
    },
  );

  it("keeps the query in a finance organization when another preferred organization lacks finance access", () => {
    const user: AuthUser = {
      id: "staff-1",
      displayName: "财务工作人员",
      phoneVerified: false,
      memberships: [
        { organizationId: "ordinary-org", role: "OPERATOR" },
        { organizationId: "finance-org", role: "FINANCE_APPROVER" },
      ],
    };
    const html = renderToStaticMarkup(
      <StoredValueLedgerWorkspace
        token="session"
        user={user}
        preferredOrganizationId="ordinary-org"
      />,
    );
    expect(html).toContain("finance-org");
    expect(html).not.toContain("ordinary-org");
    expect(html).toContain("wallet-ledger-filters");
  });
});
