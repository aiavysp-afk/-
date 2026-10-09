import { describe, expect, it } from "vitest";
import {
  AdminStoredValueLedgerQuerySchema,
  AdminStoredValueLedgerSchema,
  TechnicianWorkbenchOrderSchema,
  AdminPaymentViewSchema,
} from "./index.js";

describe("finance and technician synchronization contracts", () => {
  it("bounds organization ledger lists and supports a precise optional customer", () => {
    expect(AdminStoredValueLedgerQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(
      AdminStoredValueLedgerQuerySchema.parse({
        limit: "100",
        customerId: "customer-1",
      }),
    ).toEqual({ limit: 100, customerId: "customer-1" });
    for (const limit of [0, 101, 1.5, "invalid"])
      expect(
        AdminStoredValueLedgerQuerySchema.safeParse({ limit }).success,
      ).toBe(false);
    expect(
      AdminStoredValueLedgerQuerySchema.safeParse({ customerId: "" }).success,
    ).toBe(false);
    expect(
      AdminStoredValueLedgerQuerySchema.safeParse({
        organizationId: "other-org",
      }).success,
    ).toBe(false);
  });
  it("keeps the technician payment summary free of payer identity", () => {
    const result = TechnicianWorkbenchOrderSchema.parse({
      id: "order",
      orderNo: "ZY001",
      serviceName: "service",
      durationMinutes: 60,
      status: "PAID",
      appointmentStart: "2026-10-10T01:00:00Z",
      appointmentEnd: "2026-10-10T02:00:00Z",
      destination: null,
      payment: {
        kind: "FRIEND",
        status: "SUCCEEDED",
        succeededAt: "2026-10-10T00:00:00Z",
        payerUserId: "private",
      },
    });
    expect(result.payment).toEqual({
      kind: "FRIEND",
      status: "SUCCEEDED",
      succeededAt: "2026-10-10T00:00:00Z",
    });
  });
  it("keeps review fields compatible with a historical finance response", () => {
    const result = AdminPaymentViewSchema.parse({
      id: "payment",
      orderId: "order",
      orderNo: "ZY001",
      orderStatus: "PAID",
      status: "SUCCEEDED",
      provider: "WECHAT",
      amountFen: 19800,
      reservedFen: 0,
      refundedFen: 0,
      availableFen: 19800,
      kind: "SELF",
      payer: null,
      succeededAt: null,
    });
    expect(result).toMatchObject({
      failureCode: null,
      recoveryReviewAt: null,
      reviewRequired: false,
    });
  });
  it("accepts an empty scoped ledger without fabricating money", () => {
    expect(
      AdminStoredValueLedgerSchema.parse({
        organizationId: "org-1",
        generatedAt: "2026-10-10T00:00:00Z",
        limit: 50,
        summary: {
          balanceFen: 0,
          successfulRechargeFen: 0,
          successfulRechargeCount: 0,
        },
        accounts: [],
        recharges: [],
        transactions: [],
        hasMore: { accounts: false, recharges: false, transactions: false },
      }).summary.balanceFen,
    ).toBe(0);
  });
});
