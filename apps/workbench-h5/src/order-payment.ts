import type { PaymentStatus, TechnicianWorkbenchOrder } from "@zydj/contracts";

type WorkbenchPayment = NonNullable<TechnicianWorkbenchOrder["payment"]>;

const paymentStatusLabels: Record<PaymentStatus, string> = {
  PENDING: "待支付",
  SUCCEEDED: "支付成功",
  CLOSED: "支付已关闭",
  FAILED: "支付失败",
  REFUNDING: "退款中",
  REFUNDED: "已退款",
};

export function workbenchPaymentSummary(
  payment: WorkbenchPayment | null | undefined,
) {
  if (!payment)
    return { origin: "", status: "暂无支付记录", succeededAt: null };
  const received = ["SUCCEEDED", "REFUNDING", "REFUNDED"].includes(
    payment.status,
  );
  const succeededAt =
    received &&
    payment.succeededAt &&
    Number.isFinite(Date.parse(payment.succeededAt))
      ? payment.succeededAt
      : null;
  return {
    origin: payment.kind === "FRIEND" ? "好友代付" : "本人支付",
    status:
      received && !succeededAt
        ? "收款记录待核实"
        : paymentStatusLabels[payment.status],
    succeededAt,
  };
}
