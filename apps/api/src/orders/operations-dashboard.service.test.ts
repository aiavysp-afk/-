import { ForbiddenException } from "@nestjs/common";
import { OrderStatus, PaymentStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { OperationsDashboardService } from "./operations-dashboard.service.js";

const principal: AuthPrincipal = {
  sessionId: "session-operator",
  userId: "operator-1",
  displayName: "运营",
  memberships: [{ organizationId: "org-1", role: "OPERATOR" }],
};

describe("OperationsDashboardService", () => {
  it("returns organization-scoped real metrics in Shanghai time", async () => {
    const prisma = {
      order: {
        count: vi
          .fn()
          .mockResolvedValueOnce(3)
          .mockResolvedValueOnce(2)
          .mockResolvedValueOnce(1),
        findMany: vi.fn().mockResolvedValue([
          {
            id: "order-1",
            orderNo: "ZY202610070001",
            status: OrderStatus.PAID,
            appointmentStart: new Date("2026-10-07T06:00:00.000Z"),
            payableFen: 19_800n,
            customer: { displayName: "测试客户" },
            therapist: { displayName: "测试技师" },
            items: [{ serviceName: "肩颈舒缓" }],
          },
        ]),
      },
      payment: {
        aggregate: vi.fn().mockResolvedValue({ _sum: { amountFen: 19_800n } }),
        count: vi.fn().mockResolvedValue(2),
        fields: { amountFen: "Payment.amountFen" },
      },
      refund: { count: vi.fn().mockResolvedValue(1) },
      safetyIncident: { count: vi.fn().mockResolvedValue(2) },
    };
    const access = { assertPermission: vi.fn() };
    const service = new OperationsDashboardService(
      prisma as never,
      access as never,
    );

    const result = await service.get(
      principal,
      "org-1",
      new Date("2026-10-07T08:00:00.000Z"),
    );

    expect(access.assertPermission).toHaveBeenCalledWith(
      principal,
      "orders.read",
      "org-1",
    );
    expect(result).toMatchObject({
      day: "2026-10-07",
      timeZone: "Asia/Shanghai",
      metrics: {
        todayOrders: 3,
        activeOrders: 2,
        paidTodayFen: 19_800,
        attentionRequired: 6,
      },
      recentOrders: [
        {
          orderNo: "ZY202610070001",
          customerName: "测试客户",
          therapistName: "测试技师",
          payableFen: 19_800,
        },
      ],
    });
    expect(prisma.payment.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: {
            in: [
              PaymentStatus.SUCCEEDED,
              PaymentStatus.REFUNDING,
              PaymentStatus.REFUNDED,
            ],
          },
          order: { organizationId: "org-1" },
        }),
      }),
    );
    expect(prisma.payment.count).toHaveBeenCalledWith({
      where: {
        order: { organizationId: "org-1" },
        OR: [
          {
            status: { in: [PaymentStatus.SUCCEEDED, PaymentStatus.REFUNDING] },
            failureCode: "FULFILLMENT_REVIEW_REQUIRED",
            refundedFen: { lt: "Payment.amountFen" },
          },
          { status: PaymentStatus.PENDING, recoveryReviewAt: { not: null } },
        ],
      },
    });
    // A stopped recovery is counted through paymentAttention once, even when its order is overdue.
    expect(prisma.order.count).toHaveBeenLastCalledWith({
      where: {
        organizationId: "org-1",
        status: OrderStatus.PENDING_PAYMENT,
        paymentExpiresAt: { lt: new Date("2026-10-07T08:00:00.000Z") },
        OR: [
          { payment: { is: null } },
          { payment: { is: { recoveryReviewAt: null } } },
        ],
      },
    });
  });

  it("does not query when the principal lacks organization access", async () => {
    const access = {
      assertPermission: vi.fn(() => {
        throw new ForbiddenException();
      }),
    };
    const prisma = { order: { count: vi.fn() } };
    const service = new OperationsDashboardService(
      prisma as never,
      access as never,
    );

    await expect(service.get(principal, "org-2")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.order.count).not.toHaveBeenCalled();
  });
});
