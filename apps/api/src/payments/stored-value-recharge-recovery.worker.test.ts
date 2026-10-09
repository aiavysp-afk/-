import { describe, expect, it, vi } from "vitest";
import { StoredValueRechargeRecoveryWorker } from "./stored-value-recharge-recovery.worker.js";

describe("Stored value original-order recovery worker", () => {
  it("neither schedules nor scans when the original-order recovery gate is closed", async () => {
    const prisma = { storedValueRecharge: { findMany: vi.fn() } };
    const worker = new StoredValueRechargeRecoveryWorker(
      prisma as never,
      { recoveryEnabled: () => false } as never,
    );
    worker.onModuleInit();
    expect(await worker.run()).toBe(0);
    expect(prisma.storedValueRecharge.findMany).not.toHaveBeenCalled();
    worker.onModuleDestroy();
  });
  it("queries bounded unresolved originals and continues after one failure", async () => {
    const prisma = {
      storedValueRecharge: {
        findFirst: vi.fn().mockResolvedValue({ id: "two" }),
        findMany: vi.fn().mockResolvedValue([{ id: "one" }, { id: "two" }]),
      },
    };
    const service = {
      recoveryEnabled: () => true,
      recoverExisting: vi
        .fn()
        .mockRejectedValueOnce(new Error("provider private detail"))
        .mockResolvedValueOnce(true),
    };
    const worker = new StoredValueRechargeRecoveryWorker(
      prisma as never,
      service as never,
    );
    const now = new Date("2026-10-10T12:00:00Z");
    expect(await worker.run(now)).toBe(1);
    expect(service.recoverExisting).toHaveBeenCalledTimes(2);
    expect(prisma.storedValueRecharge.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 10,
        select: { id: true },
        where: expect.objectContaining({
          status: { in: ["PENDING", "UNKNOWN"] },
          createdAt: { lte: new Date(now.getTime() - 30_000) },
        }),
      }),
    );
  });
  it("seeks past previous originals and wraps rather than starving newer records", async () => {
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([{ id: "a" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const worker = new StoredValueRechargeRecoveryWorker(
      {
        storedValueRecharge: {
          findFirst: vi.fn().mockResolvedValue({ id: "z" }),
          findMany,
        },
      } as never,
      {
        recoveryEnabled: () => true,
        recoverExisting: vi.fn().mockResolvedValue(false),
      } as never,
    );
    await worker.run();
    await worker.run();
    await worker.run();
    expect(findMany.mock.calls[1]![0].where.id).toEqual({ gt: "a", lte: "z" });
    expect(findMany.mock.calls[2]![0].where.id).toEqual({ lte: "z" });
  });
  it("revisits old originals even when higher IDs arrive continuously", async () => {
    const records = [{ id: "a" }, { id: "b" }];
    const findFirst = vi.fn(async () => records.at(-1));
    const findMany = vi.fn(
      async ({ where }: { where: { id: { gt?: string; lte: string } } }) =>
        records
          .filter(
            (row) =>
              row.id <= where.id.lte && (!where.id.gt || row.id > where.id.gt),
          )
          .slice(0, 1),
    );
    const recoverExisting = vi.fn().mockResolvedValue(false);
    const worker = new StoredValueRechargeRecoveryWorker(
      { storedValueRecharge: { findFirst, findMany } } as never,
      { recoveryEnabled: () => true, recoverExisting } as never,
    );
    await worker.run();
    records.push({ id: "c" });
    await worker.run();
    records.push({ id: "d" });
    await worker.run();
    expect(recoverExisting.mock.calls.map((args) => args[0])).toEqual([
      "a",
      "b",
      "a",
    ]);
    expect(findFirst).toHaveBeenCalledTimes(2);
  });
  it("does not overlap scans in the same process", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const findMany = vi.fn(async () => {
      await pending;
      return [];
    });
    const worker = new StoredValueRechargeRecoveryWorker(
      {
        storedValueRecharge: {
          findFirst: vi.fn().mockResolvedValue({ id: "z" }),
          findMany,
        },
      } as never,
      { recoveryEnabled: () => true } as never,
    );
    const first = worker.run();
    expect(await worker.run()).toBe(0);
    finish();
    await first;
    expect(findMany).toHaveBeenCalledOnce();
  });
});
