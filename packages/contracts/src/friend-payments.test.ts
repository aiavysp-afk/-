import { describe, expect, it } from "vitest";
import {
  AdminPaymentViewSchema,
  FriendPaymentShareSchema,
  FriendPaymentSummarySchema,
  PaymentNotificationSchema,
} from "./index.js";
describe("friend payment public privacy contracts", () => {
  it("requires a high-entropy formatted capability and fixed miniapp destination", () => {
    const token = "A".repeat(43);
    const valid = {
      token,
      miniappPath: `/pages/friend-payment/index?token=${token}`,
      amountFen: 49800,
      expiresAt: "2026-10-09T08:15:00.000Z",
    };
    expect(FriendPaymentShareSchema.safeParse(valid).success).toBe(true);
    expect(
      FriendPaymentShareSchema.safeParse({ ...valid, token: "short" }).success,
    ).toBe(false);
    expect(
      FriendPaymentShareSchema.safeParse({
        ...valid,
        miniappPath: "https://other.example/pay",
      }).success,
    ).toBe(false);
  });
  it("strips customer identity and private delivery data from friend summaries", () => {
    const result = FriendPaymentSummarySchema.parse({
      state: "PENDING_PAYMENT",
      serviceItems: [
        {
          serviceName: "SPA",
          durationMinutes: 120,
          quantity: 1,
          serviceId: "private",
        },
      ],
      serviceProviderName: "中原到家",
      appointmentAt: "2026-10-09T10:00:00.000Z",
      amountFen: 49800,
      expiresAt: "2026-10-09T08:15:00.000Z",
      isOrderOwner: false,
      canPay: true,
      paymentClaimedByYou: false,
      rightsNotice: "权益归下单人",
      address: "private",
      phone: "private",
      customerId: "private",
      openid: "private",
    });
    expect(result).not.toHaveProperty("address");
    expect(result).not.toHaveProperty("phone");
    expect(result).not.toHaveProperty("customerId");
    expect(result).not.toHaveProperty("openid");
    expect(result.serviceItems[0]).not.toHaveProperty("serviceId");
  });
  it("requires durable customer message identifiers without payer data", () => {
    const result = PaymentNotificationSchema.parse({
      id: "event",
      orderId: "order",
      title: "好友代付成功",
      body: "订单已支付",
      createdAt: "2026-10-09T08:00:00.000Z",
      payerUserId: "private",
      openid: "private",
    });
    expect(result).not.toHaveProperty("payerUserId");
    expect(result).not.toHaveProperty("openid");
  });
  it("admin payment views retain only the authorized user id and nickname, no payer hash or mobile", () => {
    const result = AdminPaymentViewSchema.parse({
      id: "payment",
      orderId: "order",
      orderNo: "ZY001",
      orderStatus: "PAID",
      status: "SUCCEEDED",
      provider: "WECHAT",
      amountFen: 49800,
      reservedFen: 0,
      refundedFen: 0,
      availableFen: 49800,
      kind: "FRIEND",
      payer: { userId: "friend", displayName: "好友", phone: "private" },
      payerOpenIdHash: "private",
      succeededAt: "2026-10-09T08:00:00.000Z",
    });
    expect(result).not.toHaveProperty("payerOpenIdHash");
    expect(result.payer).not.toHaveProperty("phone");
  });
});
