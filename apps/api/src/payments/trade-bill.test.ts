import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { compareTradeBill, parseTradeBill, type TradeBillRow } from "./trade-bill.js";

const header = "公众账号ID,商户号,微信订单号,商户订单号,交易状态,货币种类,订单金额,手续费,商户退款单号,申请退款金额,退款状态,商品名称";
const row = "`test-app,`1234567890,`wx-1,`PAY123,`SUCCESS,`CNY,`198.00,`1.19,`0,`0.00,`,\"`SPA,按摩\"";
const summary = "总交易单数,订单总金额\n`1,`198.00";
const bill = (line = row) => Buffer.from(`${header}\n${line}\n${summary}\n`);
const local = { merchantPaymentNo: "PAY123", providerTransactionId: "wx-1", amountFen: 19800n, status: "SUCCEEDED" };

describe("Wechat trade bill parsing and comparison", () => {
  it("handles BOM/backticks/quoted product commas with exact integer-fen arithmetic", () => {
    const rows = parseTradeBill(Buffer.concat([Buffer.from("\uFEFF"), bill()]));
    expect(rows[0]).toMatchObject({ merchantPaymentNo: "PAY123", amountFen: 19800n, feeFen: 119n });
    expect(rows[0]).not.toHaveProperty("用户标识");
    expect(compareTradeBill(rows, [local])).toEqual({ channelPaidFen: "19800", channelFeeFen: "119", matched: true, differences: [] });
  });
  it("reports amount and transaction differences without rounding or changes", () => {
    const report = compareTradeBill(parseTradeBill(bill()), [{ ...local, amountFen: 19799n, providerTransactionId: "other-txn" }]);
    expect(report.matched).toBe(false);
    expect(report.differences).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "AMOUNT_MISMATCH", channelFen: "19800", localFen: "19799" }), expect.objectContaining({ kind: "TRANSACTION_MISMATCH" })]));
  });
  it("identifies missing local and missing channel payments", () => {
    expect(compareTradeBill(parseTradeBill(bill()), []).differences[0]?.kind).toBe("MISSING_LOCAL_PAYMENT");
    expect(compareTradeBill([], [local]).differences[0]?.kind).toBe("MISSING_CHANNEL_PAYMENT");
  });
  it("identifies unconfirmed local payment and duplicate channel rows", () => {
    const rows = parseTradeBill(bill());
    const report = compareTradeBill([...rows, ...rows], [{ ...local, status: "PENDING" }]);
    expect(report.differences).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "LOCAL_PAYMENT_NOT_CONFIRMED" }), expect.objectContaining({ kind: "DUPLICATE_CHANNEL_PAYMENT" })]));
  });
  it("treats refund bill entries as requiring query, never confirmed refunds", () => {
    const rows: TradeBillRow[] = [{ ...parseTradeBill(bill())[0]!, state: "REFUND", requestedRefundFen: 10000n, merchantRefundNo: "REFUND123", refundState: "PROCESSING" }];
    const report = compareTradeBill(rows, []);
    expect(report.channelPaidFen).toBe("0");
    expect(report.differences).toEqual([{ merchantPaymentNo: "PAY123", kind: "REFUND_REQUIRES_QUERY", channelFen: "10000" }]);
  });
  it("handles negative refund fees without floating-point rounding", () => {
    const line = "`test-app,`1234567890,`wx-1,`PAY123,`REFUND,`CNY,`0.00,`-0.60,`REFUND123,`100.00,`PROCESSING,`SPA";
    const rows = parseTradeBill(bill(line));
    expect(rows[0]?.feeFen).toBe(-60n);
    expect(compareTradeBill(rows, []).channelFeeFen).toBe("-60");
  });
  it.each([row.replace("198.00", "198.001"), row.replace("CNY", "USD"), row.replace("SUCCESS", "UNKNOWN")])("rejects invalid detail %s", (line) => {
    expect(() => parseTradeBill(bill(line))).toThrow(BadRequestException);
  });
  it("rejects missing or mismatched summaries instead of treating truncated bills as complete", () => {
    expect(() => parseTradeBill(Buffer.from(`${header}\n${row}`))).toThrow(BadRequestException);
    expect(() => parseTradeBill(Buffer.from(`${header}\n${row}\n总交易单数\n\u00602`))).toThrow(BadRequestException);
  });
});
