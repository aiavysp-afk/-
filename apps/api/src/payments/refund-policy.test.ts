import { ConflictException } from "@nestjs/common";
import { OrderStatus, PaymentStatus, RefundReason } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { calculateRefund } from "./refund-policy.js";

const paid = {
  status: PaymentStatus.SUCCEEDED,
  amountFen: 19800n,
  refundedFen: 0n,
  refundReservedFen: 0n,
  failureCode: null,
};
describe("Server-calculated pre-service refund policy", () => {
  it("returns outstanding full amount, never a client price", () => {
    expect(
      calculateRefund(paid, OrderStatus.PAID, RefundReason.CUSTOMER_CANCELLED),
    ).toBe(19800n);
    expect(
      calculateRefund(
        { ...paid, refundedFen: 10000n },
        OrderStatus.PAID,
        RefundReason.UNFULFILLABLE,
      ),
    ).toBe(9800n);
  });
  it("allows recorded late payment on an already cancelled order", () => {
    expect(
      calculateRefund(
        { ...paid, failureCode: "FULFILLMENT_REVIEW_REQUIRED" },
        OrderStatus.CANCELLED,
        RefundReason.LATE_PAYMENT,
      ),
    ).toBe(19800n);
  });
  it.each([
    OrderStatus.IN_SERVICE,
    OrderStatus.COMPLETED,
    OrderStatus.AWAITING_CONFIRMATION,
    OrderStatus.PENDING_PAYMENT,
  ])("requires separate policy review for %s", (status) => {
    expect(() =>
      calculateRefund(paid, status, RefundReason.CUSTOMER_CANCELLED),
    ).toThrow(ConflictException);
  });
  it("rejects occupied quota, fully refunded payment and unconfirmed payment", () => {
    expect(() =>
      calculateRefund(
        { ...paid, refundReservedFen: 100n },
        OrderStatus.PAID,
        RefundReason.UNFULFILLABLE,
      ),
    ).toThrow(ConflictException);
    expect(() =>
      calculateRefund(
        { ...paid, refundedFen: 19800n },
        OrderStatus.PAID,
        RefundReason.UNFULFILLABLE,
      ),
    ).toThrow(ConflictException);
    expect(() =>
      calculateRefund(
        { ...paid, status: PaymentStatus.PENDING },
        OrderStatus.PAID,
        RefundReason.UNFULFILLABLE,
      ),
    ).toThrow(ConflictException);
  });
  it("rejects an unverified late-payment claim", () => {
    expect(() =>
      calculateRefund(paid, OrderStatus.CANCELLED, RefundReason.LATE_PAYMENT),
    ).toThrow(ConflictException);
  });
});
