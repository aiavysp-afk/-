import { describe, expect, it, vi } from "vitest";
import { WechatRecoveryWorker } from "./wechat-recovery.worker.js";
describe("Wechat recovery worker", () => {
  it("does not scan or schedule when disabled", async () => {
    const prisma = { payment: { findMany: vi.fn() } };
    const worker = new WechatRecoveryWorker(
      prisma as never,
      { enabled: () => false } as never,
    );
    worker.onModuleInit();
    expect(await worker.run()).toBe(0);
    expect(prisma.payment.findMany).not.toHaveBeenCalled();
    worker.onModuleDestroy();
  });
  it("scans bounded pending originals, excludes active leases and continues after a failed item", async () => {
    const prisma = {
      payment: { findMany: vi.fn(async () => [{ id: "one" }, { id: "two" }]) },
    };
    const recovery = {
      enabled: () => true,
      recover: vi
        .fn()
        .mockRejectedValueOnce(new Error("private detail"))
        .mockResolvedValueOnce(true),
    };
    const worker = new WechatRecoveryWorker(prisma as never, recovery as never);
    expect(await worker.run()).toBe(1);
    expect(recovery.recover).toHaveBeenCalledTimes(2);
    expect(prisma.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 10,
        where: expect.objectContaining({
          status: "PENDING",
          recoveryAttempts: { lte: 12 },
        }),
      }),
    );
  });
  it("does not overlap in-process scans", async () => {
    let unblock!: () => void;
    const wait = new Promise<void>((r) => (unblock = r));
    const prisma = {
      payment: {
        findMany: vi.fn(async () => {
          await wait;
          return [];
        }),
      },
    };
    const worker = new WechatRecoveryWorker(
      prisma as never,
      { enabled: () => true } as never,
    );
    const first = worker.run();
    expect(await worker.run()).toBe(0);
    unblock();
    await first;
    expect(prisma.payment.findMany).toHaveBeenCalledOnce();
  });
});
