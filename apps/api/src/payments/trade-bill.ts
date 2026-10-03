import { BadRequestException } from "@nestjs/common";

export interface TradeBillRow {
  appId: string;
  merchantId: string;
  merchantPaymentNo: string;
  transactionId: string;
  state: "SUCCESS" | "REFUND" | "REVOKED";
  amountFen: bigint;
  feeFen: bigint;
  merchantRefundNo: string;
  providerRefundId: string;
  requestedRefundFen: bigint;
  refundState: string;
}

const fen = (value: string, signed = false) => {
  if (!(signed ? /^-?\d+\.\d{2}$/ : /^\d+\.\d{2}$/).test(value))
    throw new BadRequestException("账单金额格式无效");
  return BigInt(value.replace(".", ""));
};

// Supports quoted commas/newlines and Wechat's leading backtick, preserving IDs.
function csvRows(text: string) {
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (quoted || field === "" || field === "`") quoted = !quoted;
      else field += char;
    } else if (!quoted && (char === "," || char === "\n")) {
      row.push(field.replace(/\r$/, "").replace(/^`/, ""));
      field = "";
      if (char === "\n") {
        if (row.some(Boolean)) rows.push(row);
        row = [];
      }
    } else field += char;
  }
  if (quoted) throw new BadRequestException("账单 CSV 未闭合");
  if (field || row.length) {
    row.push(field.replace(/\r$/, "").replace(/^`/, ""));
    rows.push(row);
  }
  return rows;
}

export function parseTradeBill(bytes: Buffer): TradeBillRow[] {
  const rows = csvRows(bytes.toString("utf8").replace(/^\uFEFF/, ""));
  const header = rows.shift();
  const required = [
    "公众账号ID",
    "商户号",
    "微信订单号",
    "商户订单号",
    "交易状态",
    "货币种类",
    "订单金额",
    "手续费",
    "商户退款单号",
    "申请退款金额",
    "退款状态",
  ];
  if (
    !header ||
    required.some((name) => !header.includes(name)) ||
    new Set(header).size !== header.length
  )
    throw new BadRequestException("不支持当前交易账单表头，需人工核查");
  const get = (row: string[], name: string) => row[header.indexOf(name)] ?? "";
  const result: TradeBillRow[] = [];
  let summarySeen = false;
  for (const [index, row] of rows.entries()) {
    if (row[0] === "总交易单数") {
      if (index !== rows.length - 2 || !rows[index + 1])
        throw new BadRequestException("交易账单汇总结构无效");
      const count = rows[index + 1]![0]!;
      if (!/^\d+$/.test(count) || BigInt(count) !== BigInt(result.length))
        throw new BadRequestException("交易账单明细数量与汇总不一致");
      summarySeen = true;
      break;
    }
    if (row.length !== header.length || get(row, "货币种类") !== "CNY")
      throw new BadRequestException("交易账单行格式或币种无效");
    const state = get(row, "交易状态");
    if (state !== "SUCCESS" && state !== "REFUND" && state !== "REVOKED")
      throw new BadRequestException("未知交易账单状态");
    result.push({
      appId: get(row, "公众账号ID"),
      merchantId: get(row, "商户号"),
      merchantPaymentNo: get(row, "商户订单号"),
      transactionId: get(row, "微信订单号"),
      state,
      amountFen: fen(get(row, "订单金额")),
      feeFen: fen(get(row, "手续费"), true),
      merchantRefundNo: get(row, "商户退款单号"),
      providerRefundId: get(row, "微信退款单号"),
      requestedRefundFen: fen(get(row, "申请退款金额")),
      refundState: get(row, "退款状态"),
    });
  }
  if (!summarySeen)
    throw new BadRequestException("交易账单缺少汇总，需核实文件完整性");
  return result;
}

export interface LocalBillPayment {
  expectedOnDate?: boolean;
  merchantPaymentNo: string;
  providerTransactionId: string | null;
  amountFen: bigint;
  status: string;
}

export interface LocalBillRefund {
  expectedOnDate?: boolean;
  merchantRefundNo: string;
  merchantPaymentNo: string;
  providerRefundId: string | null;
  amountFen: bigint;
  status: string;
}

export function compareTradeBill(
  rows: TradeBillRow[],
  local: LocalBillPayment[],
  localRefunds: LocalBillRefund[] = [],
) {
  const localMap = new Map(
    local.map((payment) => [payment.merchantPaymentNo, payment]),
  );
  const seen = new Set<string>();
  const refundMap = new Map(
    localRefunds.map((refund) => [refund.merchantRefundNo, refund]),
  );
  const seenRefunds = new Set<string>();
  const differences: {
    merchantPaymentNo: string;
    kind: string;
    channelFen?: string;
    localFen?: string;
    merchantRefundNo?: string;
  }[] = [];
  let channelPaidFen = 0n,
    channelFeeFen = 0n;
  for (const row of rows) {
    channelFeeFen += row.feeFen;
    const payment = localMap.get(row.merchantPaymentNo);
    if (row.state !== "SUCCESS") {
      // Bill REFUND rows describe acceptance, not necessarily current refund success.
      const refund = refundMap.get(row.merchantRefundNo);
      const context = {
        merchantPaymentNo: row.merchantPaymentNo,
        merchantRefundNo: row.merchantRefundNo,
      };
      if (seenRefunds.has(row.merchantRefundNo))
        differences.push({ ...context, kind: "DUPLICATE_CHANNEL_REFUND" });
      seenRefunds.add(row.merchantRefundNo);
      if (!refund)
        differences.push({
          ...context,
          kind: "MISSING_LOCAL_REFUND",
          channelFen: row.requestedRefundFen.toString(),
        });
      else {
        if (row.requestedRefundFen !== refund.amountFen)
          differences.push({
            ...context,
            kind: "REFUND_AMOUNT_MISMATCH",
            channelFen: row.requestedRefundFen.toString(),
            localFen: refund.amountFen.toString(),
          });
        if (
          row.providerRefundId !== refund.providerRefundId ||
          row.merchantPaymentNo !== refund.merchantPaymentNo
        )
          differences.push({ ...context, kind: "REFUND_TRANSACTION_MISMATCH" });
      }
      if (
        row.state === "REVOKED" ||
        row.refundState !== "SUCCESS" ||
        !refund ||
        refund.status !== "SUCCEEDED"
      )
        differences.push({
          ...context,
          kind: "REFUND_REQUIRES_QUERY",
          channelFen: row.requestedRefundFen.toString(),
        });
      continue;
    }
    channelPaidFen += row.amountFen;
    if (seen.has(row.merchantPaymentNo))
      differences.push({
        merchantPaymentNo: row.merchantPaymentNo,
        kind: "DUPLICATE_CHANNEL_PAYMENT",
      });
    seen.add(row.merchantPaymentNo);
    if (!payment) {
      differences.push({
        merchantPaymentNo: row.merchantPaymentNo,
        kind: "MISSING_LOCAL_PAYMENT",
        channelFen: row.amountFen.toString(),
      });
      continue;
    }
    if (row.amountFen !== payment.amountFen)
      differences.push({
        merchantPaymentNo: row.merchantPaymentNo,
        kind: "AMOUNT_MISMATCH",
        channelFen: row.amountFen.toString(),
        localFen: payment.amountFen.toString(),
      });
    if (row.transactionId !== payment.providerTransactionId)
      differences.push({
        merchantPaymentNo: row.merchantPaymentNo,
        kind: "TRANSACTION_MISMATCH",
      });
    if (!["SUCCEEDED", "REFUNDING", "REFUNDED"].includes(payment.status))
      differences.push({
        merchantPaymentNo: row.merchantPaymentNo,
        kind: "LOCAL_PAYMENT_NOT_CONFIRMED",
      });
  }
  for (const payment of local)
    if (
      payment.expectedOnDate !== false &&
      !seen.has(payment.merchantPaymentNo) &&
      ["SUCCEEDED", "REFUNDING", "REFUNDED"].includes(payment.status)
    )
      differences.push({
        merchantPaymentNo: payment.merchantPaymentNo,
        kind: "MISSING_CHANNEL_PAYMENT",
        localFen: payment.amountFen.toString(),
      });
  for (const refund of localRefunds)
    if (
      refund.expectedOnDate !== false &&
      !seenRefunds.has(refund.merchantRefundNo)
    )
      differences.push({
        merchantPaymentNo: refund.merchantPaymentNo,
        merchantRefundNo: refund.merchantRefundNo,
        kind: "MISSING_CHANNEL_REFUND",
        localFen: refund.amountFen.toString(),
      });
  return {
    channelPaidFen: channelPaidFen.toString(),
    channelFeeFen: channelFeeFen.toString(),
    matched: differences.length === 0,
    differences,
  };
}
