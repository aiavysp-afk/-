import type { AdminPaymentView } from "@zydj/contracts";
import { describe, expect, it } from "vitest";
import {
  paymentHasSucceeded,
  paymentOriginLabel,
  paymentPayerLabel,
} from "./payment-origin";

const payment: AdminPaymentView = {
  id: "payment-1",
  orderId: "order-1",
  orderNo: "ZY001",
  orderStatus: "PAID",
  provider: "WECHAT",
  status: "SUCCEEDED",
  kind: "FRIEND",
  payer: { userId: "payer-1", displayName: "微信好友" },
  succeededAt: "2026-10-09T09:30:00.000Z",
  amountFen: 19800,
  reservedFen: 0,
  refundedFen: 0,
  availableFen: 19800,
};

describe("organization finance payment origin display", () => {
  it("shows a verified friend payment and its actual payer", () => {
    expect(paymentHasSucceeded(payment)).toBe(true);
    expect(paymentOriginLabel(payment)).toBe("好友代付");
    expect(paymentPayerLabel(payment)).toBe(
      "付款用户：微信好友（用户 ID：payer-1）",
    );
  });

  it("never presents a pending friend's prepayment as a completed payment", () => {
    const pending: AdminPaymentView = {
      ...payment,
      status: "PENDING",
      succeededAt: null,
      orderStatus: "PENDING_PAYMENT",
    };
    expect(paymentHasSucceeded(pending)).toBe(false);
    expect(paymentOriginLabel(pending)).toBe("好友代付（待完成）");
    expect(paymentPayerLabel(pending)).toContain("尚无成功付款");
    expect(paymentPayerLabel(pending)).toContain("代付发起用户");
  });

  it.each(["CLOSED", "FAILED"] as const)(
    "does not label an unsuccessful %s record as paid",
    (status) => {
      const unsuccessful = { ...payment, status, succeededAt: null };
      expect(paymentHasSucceeded(unsuccessful)).toBe(false);
      expect(paymentOriginLabel(unsuccessful)).toBe("好友代付（未成功）");
    },
  );

  it.each(["REFUNDING", "REFUNDED"] as const)(
    "preserves the original friend payer for %s records",
    (status) => {
      const refunded = { ...payment, status };
      expect(paymentHasSucceeded(refunded)).toBe(true);
      expect(paymentOriginLabel(refunded)).toBe("好友代付");
      expect(paymentPayerLabel(refunded)).toContain("payer-1");
    },
  );

  it("requires the persisted success timestamp, not just a success label", () => {
    expect(paymentHasSucceeded({ ...payment, succeededAt: null })).toBe(false);
    expect(paymentOriginLabel({ ...payment, succeededAt: null })).toBe(
      "好友代付（未成功）",
    );
  });

  it("does not invent a payer for legacy self payments", () => {
    const historical: AdminPaymentView = {
      ...payment,
      kind: "SELF",
      payer: null,
    };
    expect(paymentOriginLabel(historical)).toBe("本人支付");
    expect(paymentPayerLabel(historical)).toBe("历史支付未记录付款用户");
  });

  it("flags absent friend payer information instead of substituting the owner", () => {
    expect(paymentPayerLabel({ ...payment, payer: null })).toBe(
      "代付人记录缺失，需核查",
    );
  });
});
