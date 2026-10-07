import { describe, expect, it } from "vitest";
import {
  AddressVerificationCreateSchema,
  AddressVerificationSchema,
  AvailabilityQuerySchema,
  AddressSuggestionQuerySchema,
  AddressSuggestionSchema,
  BookingHoldCreateSchema,
  IdempotencyKeySchema,
  MoneyFenSchema,
  OrderCreateSchema,
  PaymentIntentSchema,
  WechatPayParametersSchema,
  RefundRequestSchema,
  RefundReviewSchema,
  SafetyDutyRosterUpsertSchema,
  SafetyDutyContactUpdateSchema,
  SafetyIncidentCloseSchema,
  SafetyIncidentCreateSchema,
  SafetyIncidentCustomerViewSchema,
  SafetyNotificationViewSchema,
  SafetyNotificationSummarySchema,
  ServiceAdminUpdateSchema,
  ShiftCreateSchema,
  TechnicianWorkbenchSchema,
  WechatMiniappLoginRequestSchema,
  formatMoney,
} from "./index.js";

describe("safety duty contracts", () => {
  it("requires two distinct responders and a bounded acknowledgement timeout", () => {
    expect(
      SafetyDutyRosterUpsertSchema.parse({
        primaryUserId: "primary-1",
        backupUserId: "backup-1",
        acknowledgementTimeoutSeconds: 120,
      }).acknowledgementTimeoutSeconds,
    ).toBe(120);
    expect(() =>
      SafetyDutyRosterUpsertSchema.parse({
        primaryUserId: "same-user",
        backupUserId: "same-user",
        acknowledgementTimeoutSeconds: 120,
      }),
    ).toThrow();
    expect(() =>
      SafetyDutyRosterUpsertSchema.parse({
        primaryUserId: "primary-1",
        backupUserId: "backup-1",
        acknowledgementTimeoutSeconds: 59,
      }),
    ).toThrow();
  });

  it("accepts only fixed incident categories and close outcomes", () => {
    expect(
      SafetyIncidentCreateSchema.parse({ category: "PERSONAL_SAFETY" }),
    ).toEqual({ category: "PERSONAL_SAFETY" });
    expect(() =>
      SafetyIncidentCreateSchema.parse({ category: "FREE_TEXT" }),
    ).toThrow();
    expect(
      SafetyIncidentCloseSchema.parse({
        resolutionCode: "REFERRED_PUBLIC_EMERGENCY",
      }),
    ).toEqual({ resolutionCode: "REFERRED_PUBLIC_EMERGENCY" });
    expect(() =>
      SafetyIncidentCloseSchema.parse({ resolutionCode: "CUSTOM_NOTE" }),
    ).toThrow();
  });

  it("keeps internal responder ids out of the customer view", () => {
    const parsed = SafetyIncidentCustomerViewSchema.parse({
      id: "incident-1",
      organizationId: "org-1",
      orderId: "order-1",
      category: "PERSONAL_SAFETY",
      status: "OPEN",
      primaryUserId: "must-be-stripped",
      backupUserId: "must-be-stripped",
      acknowledgementDueAt: "2026-10-05T03:00:00.000Z",
      acknowledgedById: null,
      acknowledgedAt: null,
      escalatedAt: null,
      resolutionCode: null,
      closedAt: null,
      createdAt: "2026-10-05T02:58:00.000Z",
    });
    expect(parsed).not.toHaveProperty("primaryUserId");
    expect(parsed).not.toHaveProperty("backupUserId");
  });
});

describe("money contract", () => {
  it("accepts RSA SDK parameters and refuses V2/invalid prepay packages", () => {
    const params = {
      timeStamp: "123",
      nonceStr: "nonce",
      package: "prepay_id=wx-test",
      signType: "RSA",
      paySign: "signature",
    };
    expect(WechatPayParametersSchema.safeParse(params).success).toBe(true);
    expect(
      WechatPayParametersSchema.safeParse({
        ...params,
        package: `prepay_id=${"a".repeat(65)}`,
      }).success,
    ).toBe(false);
    expect(
      WechatPayParametersSchema.safeParse({ ...params, signType: "MD5" })
        .success,
    ).toBe(false);
    expect(
      WechatPayParametersSchema.safeParse({
        ...params,
        package: "prepay_id=x\nextra",
      }).success,
    ).toBe(false);
  });
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
  it("keeps technician weekly shifts explicit and privacy-safe", () => {
    const parsed = TechnicianWorkbenchSchema.parse({
      displayName: "安然",
      day: "2026-10-07",
      timeZone: "Asia/Shanghai",
      generatedAt: "2026-10-07T08:00:00.000Z",
      metrics: {
        todayOrders: 0,
        activeOrders: 0,
        completedOrders: 0,
        weeklyShifts: 1,
      },
      orders: [],
      shifts: [
        {
          id: "shift-1",
          startsAt: "2026-10-08T01:00:00.000Z",
          endsAt: "2026-10-08T10:00:00.000Z",
          status: "ACTIVE",
          phone: "must-be-stripped",
        },
      ],
    });
    expect(parsed.shifts).toEqual([
      {
        id: "shift-1",
        startsAt: "2026-10-08T01:00:00.000Z",
        endsAt: "2026-10-08T10:00:00.000Z",
        status: "ACTIVE",
      },
    ]);
  });

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
          latitude: 34.75,
          longitude: 113.65,
          coordinateSystem: "GCJ-02",
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
          latitude: 34.75,
          longitude: 113.65,
          coordinateSystem: "GCJ-02",
        },
        payableFen: 1,
      }),
    ).toThrow();
  });
});

describe("address suggestion contracts", () => {
  it("accepts normalized GCJ-02 results and refuses client-selected cities", () => {
    expect(
      AddressSuggestionSchema.parse({
        id: "poi-1",
        title: "测试楼宇",
        address: "中原区测试路1号",
        city: "郑州市",
        adcode: "410102",
        latitude: 34.75,
        longitude: 113.65,
        coordinateSystem: "GCJ-02",
      }).adcode,
    ).toBe("410102");
    expect(AddressSuggestionQuerySchema.parse({ keyword: " 中原 " })).toEqual({
      keyword: "中原",
    });
    expect(() =>
      AddressSuggestionQuerySchema.parse({ keyword: "中原", city: "北京" }),
    ).toThrow();
  });
});

describe("address verification contracts", () => {
  it("accepts only an owned-reservation-shaped request and a bounded proof", () => {
    expect(
      AddressVerificationCreateSchema.parse({
        reservationId: "hold-1",
        detail: "郑州市中原区测试路 1 号 A 座",
        latitude: 34.75,
        longitude: 113.65,
        coordinateSystem: "GCJ-02",
      }),
    ).toEqual({
      reservationId: "hold-1",
      detail: "郑州市中原区测试路 1 号 A 座",
      latitude: 34.75,
      longitude: 113.65,
      coordinateSystem: "GCJ-02",
    });
    expect(() =>
      AddressVerificationCreateSchema.parse({
        reservationId: "hold-1",
        detail: "郑州市中原区测试路 1 号 A 座",
        latitude: 34.75,
        longitude: 113.65,
        coordinateSystem: "GCJ-02",
        adcode: "110101",
      }),
    ).toThrow();
    expect(
      AddressVerificationSchema.parse({
        id: "verification-1",
        reservationId: "hold-1",
        adcode: "410102",
        latitude: 34.75,
        longitude: 113.65,
        coordinateSystem: "GCJ-02",
        expiresAt: "2026-10-05T10:10:00.000Z",
      }).adcode,
    ).toBe("410102");
  });

  it("allows only the opaque proof id on an order request", () => {
    expect(
      OrderCreateSchema.parse({
        reservationId: "hold-1",
        addressVerificationId: "verification-1",
        address: {
          contactName: "林女士",
          phone: "13800000000",
          detail: "郑州市中原区测试路 1 号 A 座",
          latitude: 34.75,
          longitude: 113.65,
          coordinateSystem: "GCJ-02",
        },
      }).addressVerificationId,
    ).toBe("verification-1");
    expect(() =>
      OrderCreateSchema.parse({
        reservationId: "hold-1",
        addressVerificationId: "verification-1",
        address: {
          contactName: "林女士",
          phone: "13800000000",
          detail: "郑州市中原区测试路 1 号 A 座",
          latitude: 34.75,
          longitude: 113.65,
          coordinateSystem: "GCJ-02",
        },
        adcode: "410102",
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

describe("safety notification contracts", () => {
  it("accepts mainland duty contacts and rejects malformed or extra fields", () => {
    expect(
      SafetyDutyContactUpdateSchema.parse({ phone: "13800138000" }),
    ).toEqual({ phone: "13800138000" });
    expect(() =>
      SafetyDutyContactUpdateSchema.parse({ phone: "01012345678" }),
    ).toThrow();
    expect(() =>
      SafetyDutyContactUpdateSchema.parse({
        phone: "13800138000",
        displayName: "不允许由此接口修改",
      }),
    ).toThrow();
  });

  it("exposes operational state without provider tracking identifiers", () => {
    const notification = SafetyNotificationViewSchema.parse({
      id: "outbox-1",
      incidentId: "incident-1",
      type: "SAFETY_INCIDENT_OPENED",
      state: "DEAD_LETTER",
      attempts: 2,
      nextAttemptAt: "2026-10-05T09:00:00.000Z",
      lastErrorCode: "SMS_ACCEPTANCE_UNKNOWN",
      createdAt: "2026-10-05T08:59:00.000Z",
      publishedAt: null,
      deadLetteredAt: "2026-10-05T09:00:01.000Z",
      deliveryStatus: null,
      deliveryQueryAttempts: 0,
      deliveryCheckedAt: null,
      deliveredAt: null,
      deliveryErrorCode: null,
    });
    expect(notification.state).toBe("DEAD_LETTER");
    expect(notification).not.toHaveProperty("providerReference");
  });

  it("validates delivery monitoring summaries without provider or phone data", () => {
    expect(
      SafetyNotificationSummarySchema.parse({
        dispatchPending: 1,
        deadLetter: 0,
        awaitingReceipt: 2,
        delivered: 3,
        deliveryFailed: 0,
        deliveryUnknown: 0,
        oldestAttentionAt: "2026-10-05T09:00:00.000Z",
        attentionRequired: true,
      }).dispatchPending,
    ).toBe(1);
  });
});
