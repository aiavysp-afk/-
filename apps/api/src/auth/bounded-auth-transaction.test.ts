import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { withBoundedAuthTransaction } from "./bounded-auth-transaction.js";

describe("withBoundedAuthTransaction", () => {
  it("sets transaction-local server budgets in order before invoking the business callback", async () => {
    const tx = { $executeRaw: vi.fn().mockResolvedValue(1) };
    const operation = vi.fn(async () => "ok");
    const prisma = { $transaction: vi.fn(async (callback) => callback(tx)) };
    await expect(
      withBoundedAuthTransaction(prisma as never, operation),
    ).resolves.toBe("ok");
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 15000,
      maxWait: 5000,
    });
    expect(tx.$executeRaw.mock.calls.map((call) => call[0].join(""))).toEqual([
      "SET LOCAL lock_timeout = '10000ms'",
      "SET LOCAL statement_timeout = '12000ms'",
      "SET LOCAL idle_in_transaction_session_timeout = '12000ms'",
    ]);
    expect(operation).toHaveBeenCalledWith(tx);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw.mock.invocationCallOrder[2]).toBeLessThan(
      operation.mock.invocationCallOrder[0]!,
    );
  });
  it("never invokes business writes when initializing a server budget fails", async () => {
    const tx = {
      $executeRaw: vi
        .fn()
        .mockRejectedValue({
          code: "57014",
          message: "sensitive driver content",
        }),
    };
    const operation = vi.fn();
    const prisma = { $transaction: vi.fn(async (callback) => callback(tx)) };
    await expect(
      withBoundedAuthTransaction(prisma as never, operation),
    ).rejects.toMatchObject({
      response: {
        code: "LOGIN_BUSY",
        message: "登录请求较多，请稍后重新点击登录",
      },
    });
    expect(operation).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
  it("maps only timeout/closed-connection Prisma and PostgreSQL codes without inspecting text", async () => {
    for (const error of [
      new Prisma.PrismaClientKnownRequestError("hidden transaction text", {
        code: "P2028",
        clientVersion: "test",
      }),
      new Prisma.PrismaClientKnownRequestError("hidden connection text", {
        code: "P1017",
        clientVersion: "test",
      }),
      ...["55P03", "57014", "25P03"].map(
        (code) =>
          new Prisma.PrismaClientKnownRequestError("hidden raw query text", {
            code: "P2010",
            clientVersion: "test",
            meta: { code, message: "hidden provider text" },
          }),
      ),
    ]) {
      const prisma = { $transaction: vi.fn().mockRejectedValue(error) };
      await expect(
        withBoundedAuthTransaction(prisma as never, vi.fn()),
      ).rejects.toMatchObject({ response: { code: "LOGIN_BUSY" } });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    }
  });
  it("preserves conflict and non-timeout errors instead of silently retrying or masking them", async () => {
    for (const error of [
      new Error("ordinary failure"),
      new Prisma.PrismaClientKnownRequestError("uniqueness failure", {
        code: "P2002",
        clientVersion: "test",
      }),
      { code: "P2010", meta: { code: "23505" } },
    ]) {
      const prisma = { $transaction: vi.fn().mockRejectedValue(error) };
      await expect(
        withBoundedAuthTransaction(prisma as never, vi.fn()),
      ).rejects.toBe(error);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    }
  });
});
