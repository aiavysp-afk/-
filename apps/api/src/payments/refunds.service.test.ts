import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { PaymentProvider, RefundStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { AccessControlService } from "../auth/access-control.service.js";
import { OrderStateMachine } from "../orders/order-state-machine.js";
import { RefundsService } from "./refunds.service.js";
import type { WechatRefundResult } from "./wechat-pay.protocol.js";
import { REFUND_POLICY_VERSION } from "./refund-policy.js";

const now = new Date();
const principal = (
  id: string,
  role: "ADMIN" | "FINANCE_REQUESTER" | "FINANCE_APPROVER" = "ADMIN",
) => ({
  userId: id,
  sessionId: "session-1",
  displayName: "财务",
  memberships: [{ organizationId: "org-1", role }],
});
function setup(
  status: RefundStatus = RefundStatus.PROCESSING,
  provider: PaymentProvider = PaymentProvider.WECHAT,
) {
  const refund = {
    id: "refund-1",
    paymentId: "payment-1",
    merchantRefundNo: "RF001",
    amountFen: 19800n,
    status,
    reason: "CUSTOMER_CANCELLED" as const,
    policyVersion: REFUND_POLICY_VERSION,
    requestedById: "requester-1",
    reviewedById: "approver-1",
    reviewCode: "CONFIRMED",
    idempotencyKey: "refund-idempotency-1",
    requestFingerprint: "fingerprint",
    providerRefundId: null as string | null,
    requestedAt: now,
    reviewedAt: now,
    submittedAt: now,
    succeededAt: null as Date | null,
    nextCheckAt: now,
    checkAttempts: 0,
    updatedAt: now,
    payment: {
      id: "payment-1",
      orderId: "order-1",
      amountFen: 19800n,
      refundReservedFen: 19800n,
      refundedFen: 0n,
      status: "REFUNDING",
      provider,
      merchantPaymentNo: "PAY001",
      providerTransactionId: "TXN001",
      failureCode: null,
      order: {
        id: "order-1",
        organizationId: "org-1",
        customerId: "customer-1",
        status: "REFUNDING",
        reservationId: "hold-1",
      },
    },
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    refund: {
      findUniqueOrThrow: vi.fn().mockResolvedValue(refund),
      update: vi
        .fn()
        .mockImplementation(async ({ data }) => ({ ...refund, ...data })),
    },
    payment: { update: vi.fn().mockResolvedValue({}) },
    order: { update: vi.fn().mockResolvedValue({}) },
    appointmentReservation: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    refundEvent: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
    refundLedgerPosting: { create: vi.fn().mockResolvedValue({}) },
    orderEvent: { create: vi.fn().mockResolvedValue({}) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    outboxEvent: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    refund: {
      findUnique: vi.fn().mockResolvedValue(refund),
      findUniqueOrThrow: vi.fn().mockResolvedValue(refund),
    },
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  const client = {
    verifierConfig: () => ({ merchantId: "merchant-1" }),
    queryRefund: vi.fn(),
    submitRefund: vi.fn(),
    assertRefundEnabled: vi.fn(() => {
      throw new ServiceUnavailableException("Gate closed");
    }),
  };
  const config = {
    get: (key: string) => (key === "NODE_ENV" ? "test" : "mock"),
  };
  const service = new RefundsService(
    prisma as never,
    new AccessControlService(),
    config as never,
    client as never,
    new OrderStateMachine(),
  );
  const result: WechatRefundResult = {
    mchid: "merchant-1",
    out_trade_no: "PAY001",
    transaction_id: "TXN001",
    out_refund_no: "RF001",
    refund_id: "WXRF001",
    status: "SUCCESS",
    success_time: now.toISOString(),
    amount: { total: 19800, refund: 19800, currency: "CNY" },
  };
  return { service, tx, prisma, client, refund, result };
}

describe("RefundsService permissions, transitions and settlement", () => {
  it("forbids an admin from approving their own application", async () => {
    const { service, tx } = setup(RefundStatus.REQUESTED);
    await expect(
      service.review(principal("requester-1"), "org-1", "refund-1", true, {
        code: "CONFIRMED",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.refund.update).not.toHaveBeenCalled();
  });
  it("checks finance role and organization before mutation", async () => {
    const { service, tx } = setup(RefundStatus.REQUESTED);
    await expect(
      service.review(
        principal("reviewer-1", "FINANCE_REQUESTER"),
        "org-1",
        "refund-1",
        true,
        { code: "CONFIRMED" },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.review(principal("reviewer-1"), "other-org", "refund-1", true, {
        code: "CONFIRMED",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.refund.update).not.toHaveBeenCalled();
  });
  it("releases rejected quota without changing fulfillment/payment states", async () => {
    const { service, tx } = setup(RefundStatus.REQUESTED);
    await service.review(principal("reviewer-1"), "org-1", "refund-1", false, {
      code: "INSUFFICIENT_EVIDENCE",
    });
    expect(tx.payment.update).toHaveBeenCalledWith({
      where: { id: "payment-1" },
      data: { refundReservedFen: { decrement: 19800n } },
    });
    expect(tx.order.update).not.toHaveBeenCalled();
    expect(tx.refund.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "REJECTED",
          reviewedById: "reviewer-1",
        }),
      }),
    );
  });
  it("keeps real submission closed and leaves the approved request unchanged", async () => {
    const { service, tx, client } = setup(RefundStatus.APPROVED);
    await expect(
      service.submit(principal("reviewer-1"), "org-1", "refund-1"),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(tx.refund.update).not.toHaveBeenCalled();
    expect(client.submitRefund).not.toHaveBeenCalled();
  });
  it("requires approval before mock submission", async () => {
    const { service } = setup(RefundStatus.REQUESTED, PaymentProvider.MOCK);
    await expect(
      service.submit(principal("reviewer-1"), "org-1", "refund-1"),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  it("moves mock approval to processing without pretending completion", async () => {
    const { service, tx, prisma, refund } = setup(
      RefundStatus.APPROVED,
      PaymentProvider.MOCK,
    );
    prisma.refund.findUnique
      .mockResolvedValueOnce(refund)
      .mockResolvedValueOnce({
        ...refund,
        status: RefundStatus.PROCESSING,
        succeededAt: null,
      });
    await expect(
      service.submit(principal("reviewer-1"), "org-1", "refund-1"),
    ).resolves.toMatchObject({ status: "PROCESSING", succeededAt: null });
    expect(tx.refundLedgerPosting.create).not.toHaveBeenCalled();
  });
  it("settles verified success, moves reserved quota to refunded and appends one equal-leg posting", async () => {
    const { service, tx, result } = setup();
    await service.applyResult(result, "event-1", "NOTIFICATION");
    expect(tx.payment.update).toHaveBeenCalledWith({
      where: { id: "payment-1" },
      data: {
        refundReservedFen: { decrement: 19800n },
        refundedFen: { increment: 19800n },
        status: "REFUNDED",
      },
    });
    expect(tx.order.update).toHaveBeenCalledWith({
      where: { id: "order-1" },
      data: { status: "REFUNDED" },
    });
    expect(tx.refundLedgerPosting.create).toHaveBeenCalledWith({
      data: { refundId: "refund-1", amountFen: 19800n },
    });
    expect(tx.outboxEvent.create).toHaveBeenCalledOnce();
  });
  it("never creates another posting for duplicate success or a later stale closed result", async () => {
    const { service, tx, result, refund } = setup(RefundStatus.SUCCEEDED);
    refund.providerRefundId = "WXRF001";
    refund.succeededAt = now;
    await expect(
      service.applyResult(result, "event-1", "NOTIFICATION"),
    ).resolves.toEqual({ duplicate: true });
    await expect(
      service.applyResult(
        { ...result, status: "CLOSED", success_time: undefined },
        "event-2",
        "NOTIFICATION",
      ),
    ).resolves.toEqual({ duplicate: true });
    expect(tx.payment.update).not.toHaveBeenCalled();
    expect(tx.refundLedgerPosting.create).not.toHaveBeenCalled();
  });
  it.each(["PROCESSING", "ABNORMAL", "CLOSED"] as const)(
    "retains quota for provider result %s",
    async (status) => {
      const { service, tx, result } = setup();
      await service.applyResult(
        { ...result, status, success_time: undefined },
        `event-${status}`,
        "NOTIFICATION",
      );
      expect(tx.payment.update).not.toHaveBeenCalled();
      expect(tx.refundLedgerPosting.create).not.toHaveBeenCalled();
    },
  );
  it.each([
    { transaction_id: "wrong" },
    { amount: { total: 19800, refund: 1 } },
    { mchid: "wrong" },
  ])(
    "rejects conflicting refund identifiers or amounts %j",
    async (changes) => {
      const { service, tx, result } = setup();
      await expect(
        service.applyResult(
          { ...result, ...changes },
          "event-1",
          "NOTIFICATION",
        ),
      ).rejects.toThrow();
      expect(tx.payment.update).not.toHaveBeenCalled();
      expect(tx.refundLedgerPosting.create).not.toHaveBeenCalled();
    },
  );
  it("rejects callback success for unsubmitted approved refunds", async () => {
    const { service, tx, result, refund } = setup(RefundStatus.APPROVED);
    refund.submittedAt = null as unknown as Date;
    await expect(
      service.applyResult(result, "event-1", "NOTIFICATION"),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.refundLedgerPosting.create).not.toHaveBeenCalled();
  });
  it("does not erase an exception with a stale processing result", async () => {
    const { service, tx, result, refund } = setup(RefundStatus.ABNORMAL);
    refund.providerRefundId = "WXRF001";
    await service.applyResult(
      { ...result, status: "PROCESSING", success_time: undefined },
      "event-processing",
      "QUERY",
    );
    expect(tx.refund.update).not.toHaveBeenCalled();
  });
  it("marks a failed query unknown and retains the original refund number and quota", async () => {
    const { service, tx, client } = setup();
    client.queryRefund.mockRejectedValue(new Error("timeout"));
    await expect(service.queryProvider("refund-1")).rejects.toThrow("timeout");
    expect(tx.refund.update).toHaveBeenCalledWith({
      where: { id: "refund-1" },
      data: { status: "UNKNOWN" },
    });
    expect(tx.payment.update).not.toHaveBeenCalled();
    expect(client.queryRefund).toHaveBeenCalledWith("RF001");
  });
  it("uses verified query for the same settlement path", async () => {
    const { service, client, result, tx } = setup();
    client.queryRefund.mockResolvedValue(result);
    await service.reconcile(principal("reviewer-1"), "org-1", "refund-1");
    expect(tx.refundLedgerPosting.create).toHaveBeenCalledOnce();
  });
  it("hides mock confirmation in production", async () => {
    const { prisma, client } = setup(
      RefundStatus.PROCESSING,
      PaymentProvider.MOCK,
    );
    const service = new RefundsService(
      prisma as never,
      new AccessControlService(),
      { get: () => "production" } as never,
      client as never,
      new OrderStateMachine(),
    );
    await expect(
      service.confirmMock(principal("reviewer-1"), "org-1", "refund-1"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
