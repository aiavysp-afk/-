import { describe, expect, it } from "vitest";
import {
  AvailabilityQuerySchema,
  BookingHoldCreateSchema,
  IdempotencyKeySchema,
  MoneyFenSchema,
  OrderCreateSchema,
  PaymentIntentSchema,
  RefundRequestSchema,
  RefundReviewSchema,
  ServiceAdminUpdateSchema,
  ShiftCreateSchema,
  WechatMiniappLoginRequestSchema,
  formatMoney,
} from "./index.js";

describe("money contract", () => {
  it("preserves cents instead of rounding payable prices", () => {
    expect(formatMoney(19880)).toBe("¥198.80");
  });
  it("accepts integer fen and rejects floating values", () => {
    expect(MoneyFenSchema.parse(19800)).toBe(19800);
    expect(() => MoneyFenSchema.parse(19.8)).toThrow();
  });

  it("formats customer-facing whole-yuan prices", () => {
    expect(formatMoney(26800)).toBe("¥268");
  });
});
describe("refund contract", () => {
  it("rejects client-supplied amount and identity", () => {
    expect(
      RefundRequestSchema.safeParse({
        reason: "CUSTOMER_CANCELLED",
        amountFen: 1,
      }).success,
    ).toBe(false);
    expect(
      RefundRequestSchema.safeParse({
        reason: "CUSTOMER_CANCELLED",
        requestedById: "admin",
      }).success,
    ).toBe(false);
  });
  it("accepts only defined review outcomes", () => {
    expect(RefundReviewSchema.parse({ code: "CONFIRMED" })).toEqual({
      code: "CONFIRMED",
    });
    expect(
      RefundReviewSchema.safeParse({ code: "CONFIRMED", reviewedById: "self" })
        .success,
    ).toBe(false);
  });
});

describe("service administration contract", () => {
  it("accepts integer-fen edits and rejects empty or floating-price updates", () => {
    expect(ServiceAdminUpdateSchema.parse({ priceFen: 19_800 })).toEqual({
      priceFen: 19_800,
    });
    expect(() => ServiceAdminUpdateSchema.parse({})).toThrow();
    expect(() => ServiceAdminUpdateSchema.parse({ priceFen: 198.5 })).toThrow();
  });
});

describe("authentication contract", () => {
  it("accepts a bounded WeChat login code and rejects blank input", () => {
    expect(WechatMiniappLoginRequestSchema.parse({ code: "wx-code" })).toEqual({
      code: "wx-code",
    });
    expect(() =>
      WechatMiniappLoginRequestSchema.parse({ code: "   " }),
    ).toThrow();
  });
});

describe("scheduling contracts", () => {
  it("accepts a Shanghai availability date and rejects unsupported time zones", () => {
    expect(
      AvailabilityQuerySchema.parse({
        serviceId: "svc-neck-60",
        date: "2026-10-04",
      }),
    ).toEqual({
      serviceId: "svc-neck-60",
      date: "2026-10-04",
      timeZone: "Asia/Shanghai",
    });
    expect(() =>
      AvailabilityQuerySchema.parse({
        serviceId: "svc-neck-60",
        date: "2026-10-04",
        timeZone: "UTC",
      }),
    ).toThrow();
  });

  it("requires ordered shift boundaries and offset-aware hold timestamps", () => {
    expect(
      ShiftCreateSchema.parse({
        organizationId: "org-1",
        therapistId: "user-therapist-1",
        startsAt: "2026-10-04T10:00:00+08:00",
        endsAt: "2026-10-04T18:00:00+08:00",
      }).therapistId,
    ).toBe("user-therapist-1");
    expect(() =>
      ShiftCreateSchema.parse({
        organizationId: "org-1",
        therapistId: "user-therapist-1",
        startsAt: "2026-10-04T18:00:00+08:00",
        endsAt: "2026-10-04T10:00:00+08:00",
      }),
    ).toThrow();
    expect(() =>
      BookingHoldCreateSchema.parse({
        serviceId: "svc-neck-60",
        therapistId: "user-therapist-1",
        startsAt: "2026-10-04T10:00:00",
      }),
    ).toThrow();
  });
});

describe("order contracts", () => {
  it("accepts a bounded idempotency key and rejects short values", () => {
    expect(IdempotencyKeySchema.parse("order-20261004-0001")).toBe(
      "order-20261004-0001",
    );
    expect(() => IdempotencyKeySchema.parse("short")).toThrow();
  });

  it("accepts a strict service address without client supplied amounts", () => {
    expect(
      OrderCreateSchema.parse({
        reservationId: "hold-1",
        address: {
          contactName: "林女士",
          phone: "13800000000",
          detail: "郑州市金水区示例路 1 号",
        },
      }).reservationId,
    ).toBe("hold-1");
    expect(() =>
      OrderCreateSchema.parse({
        reservationId: "hold-1",
        address: {
          contactName: "林女士",
          phone: "13800000000",
          detail: "郑州市金水区示例路 1 号",
        },
        payableFen: 1,
      }),
    ).toThrow();
  });
});

describe("payment contracts", () => {
  it("accepts an integer-fen mock payment intent", () => {
    expect(
      PaymentIntentSchema.parse({
        id: "payment-1",
        orderId: "order-1",
        provider: "MOCK",
        status: "PENDING",
        amountFen: 19_800,
        expiresAt: "2026-10-03T00:15:00.000Z",
        mockConfirmationAvailable: true,
      }).amountFen,
    ).toBe(19_800);
    expect(() =>
      PaymentIntentSchema.parse({
        id: "payment-1",
        orderId: "order-1",
        provider: "MOCK",
        status: "PENDING",
        amountFen: 198.5,
        expiresAt: "2026-10-03T00:15:00.000Z",
        mockConfirmationAvailable: true,
      }),
    ).toThrow();
  });
});
