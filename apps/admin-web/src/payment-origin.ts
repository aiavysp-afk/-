import type { AdminPaymentView } from "@zydj/contracts";

export function paymentHasSucceeded(payment: AdminPaymentView) {
  return Boolean(
    payment.succeededAt &&
      ["SUCCEEDED", "REFUNDING", "REFUNDED"].includes(payment.status),
  );
}

export function paymentOriginLabel(payment: AdminPaymentView) {
  if (payment.kind !== "FRIEND") return "本人支付";
  if (paymentHasSucceeded(payment)) return "好友代付";
  return payment.status === "PENDING"
    ? "好友代付（待完成）"
    : "好友代付（未成功）";
}

export function paymentPayerLabel(payment: AdminPaymentView) {
  if (!payment.payer)
    return payment.kind === "FRIEND"
      ? "代付人记录缺失，需核查"
      : "历史支付未记录付款用户";
  const identity = `${payment.payer.displayName}（用户 ID：${payment.payer.userId}）`;
  if (payment.kind === "FRIEND" && !paymentHasSucceeded(payment))
    return `代付发起用户：${identity}；尚无成功付款`;
  return `付款用户：${identity}`;
}
