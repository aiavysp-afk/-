import { ConflictException } from "@nestjs/common";
import { OrderStatus, PaymentStatus, RefundReason } from "@prisma/client";

export const REFUND_POLICY_VERSION = "2026-10-03.dev-pre-service-full-v1";
const PRE_SERVICE = new Set<OrderStatus>([
  OrderStatus.PAID,
  OrderStatus.DISPATCHING,
  OrderStatus.ASSIGNED,
  OrderStatus.EN_ROUTE,
  OrderStatus.ARRIVED,
]);

export function calculateRefund(
  payment: {
    status: PaymentStatus;
    amountFen: bigint;
    refundedFen: bigint;
    refundReservedFen: bigint;
    failureCode: string | null;
  },
  orderStatus: OrderStatus,
  reason: RefundReason,
) {
  if (payment.status !== PaymentStatus.SUCCEEDED || payment.amountFen <= 0n)
    throw new ConflictException("支付尚未成功或已进入退款流程");
  const latePayment =
    payment.failureCode === "FULFILLMENT_REVIEW_REQUIRED" &&
    orderStatus === OrderStatus.CANCELLED;
  if (
    reason === RefundReason.LATE_PAYMENT
      ? !latePayment
      : !PRE_SERVICE.has(orderStatus)
  )
    throw new ConflictException(
      "当前订单需单独核实退款规则，不能使用服务开始前全额退款策略",
    );
  const amount =
    payment.amountFen - payment.refundedFen - payment.refundReservedFen;
  if (amount <= 0n || payment.refundReservedFen > 0n)
    throw new ConflictException("可退额度已被其他申请占用或已退完");
  return amount;
}
