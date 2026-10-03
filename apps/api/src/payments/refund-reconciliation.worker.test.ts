import { describe, expect, it, vi } from "vitest";
import { RefundReconciliationWorker } from "./refund-reconciliation.worker.js";
function setup(attempts = 0, provider = "wechat") {
  const row = {
    id: "refund-1",
    paymentId: "payment-1",
    status: "UNKNOWN",
    checkAttempts: attempts,
  };
  const tx = {
    refund: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    outboxEvent: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    refund: {
      findMany: vi.fn().mockResolvedValue([row]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
  };
  const refunds = { queryProvider: vi.fn().mockResolvedValue(undefined) };
  return {
    worker: new RefundReconciliationWorker(
      prisma as never,
      refunds as never,
      { get: () => provider } as never,
    ),
    prisma,
    refunds,
    tx,
  };
}
describe("refund recovery leases", () => {
  it("does nothing in mock mode", async () => {
    const { worker, prisma } = setup(0, "mock");
    expect(await worker.run()).toBe(0);
    expect(prisma.refund.findMany).not.toHaveBeenCalled();
  });
  it("polls only after an atomic lease", async () => {
    const { worker, refunds, prisma } = setup();
    expect(await worker.run()).toBe(1);
    expect(refunds.queryProvider).toHaveBeenCalledWith("refund-1");
    expect(prisma.refund.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ checkAttempts: 0 }),
        data: expect.objectContaining({ checkAttempts: 1 }),
      }),
    );
  });
  it("skips jobs leased by another instance", async () => {
    const { worker, refunds, prisma } = setup();
    prisma.refund.updateMany.mockResolvedValue({ count: 0 });
    expect(await worker.run()).toBe(0);
    expect(refunds.queryProvider).not.toHaveBeenCalled();
  });
  it("escalates unresolved attempt twelve without reposting refunds", async () => {
    const { worker, refunds, tx } = setup(11);
    refunds.queryProvider.mockRejectedValue(new Error("timeout"));
    await worker.run();
    expect(tx.outboxEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "REFUND_RECONCILIATION_REVIEW_REQUIRED",
        }),
      }),
    );
  });
  it("does not create a manual task after concurrently settled success", async () => {
    const { worker, tx } = setup(11);
    tx.refund.updateMany.mockResolvedValue({ count: 0 });
    await worker.run();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });
});
