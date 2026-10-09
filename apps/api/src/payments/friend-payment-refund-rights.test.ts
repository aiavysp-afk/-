import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { RefundsService } from "./refunds.service.js";
import { WechatRecoveryService } from "./wechat-recovery.service.js";
const payer = {
  userId: "friend",
  sessionId: "session",
  displayName: "代付人",
  memberships: [],
};
describe("friend payer never receives order cancellation or refund ownership", () => {
  it("refuses the actual payer's refund request before reading funds or sending a WeChat refund", async () => {
    const prisma = {
      order: {
        findUnique: vi.fn(async () => ({
          id: "order",
          customerId: "owner",
          payment: { kind: "FRIEND", payerUserId: "friend" },
        })),
      },
      refund: { findFirst: vi.fn() },
      payment: { findFirst: vi.fn() },
      $transaction: vi.fn(),
    };
    const client = { refund: vi.fn() };
    const service = new RefundsService(
      prisma as never,
      {} as never,
      {} as never,
      client as never,
      {} as never,
    );
    await expect(
      service.requestOwn(payer, "order", "friend-refund-key"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.payment.findFirst).not.toHaveBeenCalled();
    expect(prisma.refund.findFirst).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(client.refund).not.toHaveBeenCalled();
  });
  it("refuses the actual payer's cancellation or remote close request before provider I/O", async () => {
    const prisma = {
      order: {
        findUnique: vi.fn(async () => ({
          id: "order",
          customerId: "owner",
          payment: {
            kind: "FRIEND",
            payerUserId: "friend",
            provider: "WECHAT",
          },
        })),
      },
      $transaction: vi.fn(),
    };
    const client = {
      assertRecoveryEnabled: vi.fn(),
      closeTransaction: vi.fn(),
    };
    const orders = { cancelOwn: vi.fn() };
    const service = new WechatRecoveryService(
      prisma as never,
      {} as never,
      client as never,
      {} as never,
      orders as never,
    );
    await expect(service.closeOwnOrder(payer, "order")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(client.assertRecoveryEnabled).not.toHaveBeenCalled();
    expect(client.closeTransaction).not.toHaveBeenCalled();
    expect(orders.cancelOwn).not.toHaveBeenCalled();
  });
});
