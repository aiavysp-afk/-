import { describe, expect, it } from "vitest";
import { workbenchPaymentSummary } from "./order-payment";

describe("technician order payment summary", () => {
  it("does not turn an absent historical payment into an unpaid order", () => {
    expect(workbenchPaymentSummary(null)).toEqual({
      origin: "",
      status: "暂无支付记录",
      succeededAt: null,
    });
  });

  it("distinguishes a friend's unfinished payment from confirmed collection", () => {
    expect(
      workbenchPaymentSummary({
        kind: "FRIEND",
        status: "PENDING",
        succeededAt: null,
      }),
    ).toEqual({ origin: "好友代付", status: "待支付", succeededAt: null });
    expect(
      workbenchPaymentSummary({
        kind: "FRIEND",
        status: "SUCCEEDED",
        succeededAt: "2026-10-10T06:00:00Z",
      }),
    ).toEqual({
      origin: "好友代付",
      status: "支付成功",
      succeededAt: "2026-10-10T06:00:00Z",
    });
  });

  it.each(["REFUNDING", "REFUNDED"] as const)(
    "retains the real collection time for %s",
    (status) => {
      expect(
        workbenchPaymentSummary({
          kind: "SELF",
          status,
          succeededAt: "2026-10-10T06:00:00Z",
        }),
      ).toMatchObject({
        origin: "本人支付",
        succeededAt: "2026-10-10T06:00:00Z",
      });
    },
  );

  it.each([null, "invalid-time"])(
    "does not assert collection with an invalid success time",
    (succeededAt) => {
      expect(
        workbenchPaymentSummary({
          kind: "FRIEND",
          status: "SUCCEEDED",
          succeededAt,
        }),
      ).toEqual({
        origin: "好友代付",
        status: "收款记录待核实",
        succeededAt: null,
      });
    },
  );

  it.each(["CLOSED", "FAILED"] as const)(
    "does not display a success time for %s",
    (status) => {
      expect(
        workbenchPaymentSummary({
          kind: "SELF",
          status,
          succeededAt: "2026-10-10T06:00:00Z",
        }).succeededAt,
      ).toBeNull();
    },
  );
});
