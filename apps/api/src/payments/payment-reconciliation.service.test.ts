import { ForbiddenException } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessControlService } from "../auth/access-control.service.js";
import { PaymentReconciliationService } from "./payment-reconciliation.service.js";

const principal = { userId: "finance-1", sessionId: "session-1", displayName: "复核岗", memberships: [{ organizationId: "org-1", role: "FINANCE_APPROVER" as const }] };
function fixture() {
  const header = "公众账号ID,商户号,微信订单号,商户订单号,交易状态,货币种类,订单金额,手续费,商户退款单号,申请退款金额,退款状态";
  const own = "`app-1,`merchant-1,`txn-1,`PAY123,`SUCCESS,`CNY,`198.00,`1.19,`0,`0.00,`";
  const foreign = "`app-1,`merchant-1,`other-txn,`PRIVATE_OTHER_ORG,`SUCCESS,`CNY,`198.00,`1.19,`0,`0.00,`";
  const client = { requestTradeBill: vi.fn().mockResolvedValue({ hashValue: "hash-1" }), downloadTradeBill: vi.fn().mockResolvedValue(Buffer.from(`${header}\n${own}\n${foreign}\n总交易单数\n\u00602\n`)), verifierConfig: () => ({ appId: "app-1", merchantId: "merchant-1" }) };
  const prisma = { payment: { findMany: vi.fn().mockResolvedValue([{ merchantPaymentNo: "PAY123", providerTransactionId: "txn-1", status: "SUCCEEDED", amountFen: 19800n, succeededAt: new Date("2026-10-02T01:00:00Z") }]) }, auditLog: { create: vi.fn().mockResolvedValue({}) } };
  return { service: new PaymentReconciliationService(prisma as never, new AccessControlService(), client as never), prisma, client };
}
describe("PaymentReconciliationService scope and evidence", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-03T01:00:00Z")); });
  afterEach(() => vi.useRealTimers());
  it("compares only the organization scope and hides merchant-wide foreign identifiers", async () => {
    const { service, prisma } = fixture();
    const result = await service.daily(principal, "org-1", "2026-10-02");
    expect(result).toMatchObject({ channelPaidFen: "19800", channelFeeFen: "119", merchantScopeReviewRequired: true, matched: false });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_OTHER_ORG");
    expect(prisma.payment.findMany.mock.calls[0]![0].where.order).toEqual({ organizationId: "org-1" });
    expect(prisma.auditLog.create).toHaveBeenCalledOnce();
  });
  it("checks finance permission and organization before fetching bill data", async () => {
    const { service, client } = fixture();
    await expect(service.daily(principal, "other-org", "2026-10-02")).rejects.toBeInstanceOf(ForbiddenException);
    expect(client.requestTradeBill).not.toHaveBeenCalled();
  });
  it.each(["2026-10-03", "2026-02-30", "not-a-date"])("rejects unfinished or invalid bill date %s", async (date) => {
    const { service, client } = fixture();
    await expect(service.daily(principal, "org-1", date)).rejects.toThrow();
    expect(client.requestTradeBill).not.toHaveBeenCalled();
  });
});
