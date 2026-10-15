import { ConfigService } from "@nestjs/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateEnv, type AppEnv } from "../config/env.js";
import type { PrismaService } from "../database/prisma.service.js";
import { AliyunSmsClient } from "./aliyun-sms.client.js";
import {
  PhoneVerificationSmsBudgetService,
  phoneVerificationSmsDay,
} from "./phone-verification-sms-budget.service.js";

const configuration = (
  maximum: number,
  overrides: Record<string, unknown> = {},
) =>
  new ConfigService<AppEnv, true>(
    validateEnv({
      SMS_PROVIDER: "aliyun",
      SMS_SEND_ENABLED: "true",
      PHONE_VERIFICATION_SMS_ENABLED: "true",
      PHONE_VERIFICATION_SMS_DAILY_REQUEST_LIMIT: maximum,
      ALIYUN_SMS_ACCESS_KEY_ID: "unit-only-placeholder",
      ALIYUN_SMS_ACCESS_KEY_SECRET: "unit-only-no-live-secret",
      ALIYUN_SMS_SIGN_NAME: "测试签名",
      ALIYUN_SMS_PHONE_VERIFICATION_TEMPLATE_CODE: "SMS_UNITONLY",
      ...overrides,
    }),
  );

function database() {
  const state = {
    counters: new Map<string, number>(),
    unavailable: false,
    commits: 0,
    rollbacks: 0,
  };
  let queue = Promise.resolve();
  const tx = {
    $executeRaw: vi.fn(async (..._args: unknown[]) => 0),
    phoneVerificationRateLimit: {
      upsert: vi.fn(
        async (input: {
          where: { key: string };
          create: { count: number };
          update: { count: { increment: number } };
        }) => {
          const count = state.counters.has(input.where.key)
            ? state.counters.get(input.where.key)! +
              input.update.count.increment
            : input.create.count;
          state.counters.set(input.where.key, count);
          return { count };
        },
      ),
    },
  };
  const prisma = {
    $transaction: vi.fn(
      async (
        work: (transaction: typeof tx) => Promise<unknown>,
        _options?: unknown,
      ) => {
        const previous = queue;
        let release!: () => void;
        queue = new Promise<void>((done) => {
          release = done;
        });
        await previous;
        const before = new Map(state.counters);
        try {
          if (state.unavailable)
            throw new Error("unit-only-private-database-diagnostic");
          const result = await work(tx);
          state.commits++;
          return result;
        } catch (error) {
          state.counters = before;
          state.rollbacks++;
          throw error;
        } finally {
          release();
        }
      },
    ),
  };
  return {
    prisma: prisma as unknown as PrismaService,
    state,
    tx,
    transaction: prisma.$transaction,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("shared verification SMS request budget", () => {
  it("uses Shanghai natural days, not UTC or the execution host timezone", () => {
    expect(phoneVerificationSmsDay(new Date("2026-10-15T15:59:59.999Z"))).toBe(
      "2026-10-15",
    );
    expect(phoneVerificationSmsDay(new Date("2026-10-15T16:00:00.000Z"))).toBe(
      "2026-10-16",
    );
  });

  it.each([
    { SMS_SEND_ENABLED: "false" },
    { PHONE_VERIFICATION_SMS_ENABLED: "false" },
    { SMS_PROVIDER: "none" },
  ])("does not reserve with closed gates %j", async (override) => {
    const db = database();
    const budget = new PhoneVerificationSmsBudgetService(
      configuration(10, override),
      db.prisma,
    );
    await expect(budget.reserve()).rejects.toMatchObject({ status: 503 });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("defaults to zero and fails closed before any reservation", async () => {
    const db = database();
    const config = configuration(0);
    await expect(
      new PhoneVerificationSmsBudgetService(config, db.prisma).reserve(),
    ).rejects.toMatchObject({ status: 503 });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("uses a bounded transaction and rolls back over-budget increments", async () => {
    const db = database();
    const budget = new PhoneVerificationSmsBudgetService(
      configuration(1),
      db.prisma,
    );
    const now = new Date("2026-10-15T16:00:00.000Z");
    await budget.reserve(now);
    await expect(budget.reserve(now)).rejects.toMatchObject({ status: 429 });
    expect([...db.state.counters.entries()]).toEqual([
      ["verification-sms-request-budget:2026-10-16", 1],
    ]);
    expect(db.state.commits).toBe(1);
    expect(db.state.rollbacks).toBe(1);
    expect(db.transaction.mock.calls[0]?.[1]).toEqual({
      timeout: 15_000,
      maxWait: 5_000,
    });
    expect(db.tx.$executeRaw.mock.calls.map((call) => String(call[0]))).toEqual(
      expect.arrayContaining([
        "SET LOCAL lock_timeout = '10000ms'",
        "SET LOCAL statement_timeout = '12000ms'",
        "SET LOCAL idle_in_transaction_session_timeout = '12000ms'",
      ]),
    );
    const lockCalls = db.tx.$executeRaw.mock.calls.filter((call) =>
      String(call[0]).includes("pg_advisory_xact_lock"),
    );
    expect(lockCalls).toHaveLength(2);
    expect(lockCalls.map((call) => call[1])).toEqual([
      "verification-sms-request-budget:2026-10-16",
      "verification-sms-request-budget:2026-10-16",
    ]);
  });

  it("caps concurrent reservations globally and preserves unrelated existing limits", async () => {
    const db = database();
    db.state.counters.set("existing-anonymous-phone-hmac-fixture", 4);
    db.state.counters.set("existing-bound-phone-hmac-fixture", 7);
    const budgets = Array.from(
      { length: 3 },
      () => new PhoneVerificationSmsBudgetService(configuration(3), db.prisma),
    );
    const result = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        budgets[index % 3]!.reserve(new Date("2026-10-15T18:00:00Z")),
      ),
    );
    expect(result.filter((item) => item.status === "fulfilled")).toHaveLength(
      3,
    );
    expect(result.filter((item) => item.status === "rejected")).toHaveLength(
      17,
    );
    expect(
      db.state.counters.get("verification-sms-request-budget:2026-10-16"),
    ).toBe(3);
    expect(db.state.counters.get("existing-anonymous-phone-hmac-fixture")).toBe(
      4,
    );
    expect(db.state.counters.get("existing-bound-phone-hmac-fixture")).toBe(7);
  });

  it("opens a fresh bucket at Shanghai midnight without resetting previous counters", async () => {
    const db = database();
    const budget = new PhoneVerificationSmsBudgetService(
      configuration(1),
      db.prisma,
    );
    await budget.reserve(new Date("2026-10-15T15:59:59.999Z"));
    await budget.reserve(new Date("2026-10-15T16:00:00.000Z"));
    expect(
      db.state.counters.get("verification-sms-request-budget:2026-10-15"),
    ).toBe(1);
    expect(
      db.state.counters.get("verification-sms-request-budget:2026-10-16"),
    ).toBe(1);
  });

  it("fails closed and sanitizes database errors", async () => {
    const db = database();
    db.state.unavailable = true;
    const budget = new PhoneVerificationSmsBudgetService(
      configuration(1),
      db.prisma,
    );
    const error = await budget.reserve().catch((failure: unknown) => failure);
    expect(error).toMatchObject({ status: 503 });
    expect(String(error)).not.toContain("private-database-diagnostic");
    expect(db.state.counters.size).toBe(0);
  });

  it("shares the provider exit across callers, retaining UNKNOWN and rejection reservations", async () => {
    const db = database();
    const config = configuration(2);
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("synthetic network timeout"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ Code: "REJECTED", RequestId: "unit-request" }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    const clients = Array.from(
      { length: 3 },
      () =>
        new AliyunSmsClient(
          config,
          new PhoneVerificationSmsBudgetService(config, db.prisma),
        ),
    );
    expect(
      await clients[0]!.submitPhoneVerification({
        phone: "13800138000",
        code: "123456",
        trackingId: "anonymous-fixture",
      }),
    ).toEqual({ status: "UNKNOWN" });
    expect(
      await clients[1]!.submitPhoneVerification({
        phone: "13800138000",
        code: "123456",
        trackingId: "binding-fixture",
      }),
    ).toEqual({ status: "REJECTED" });
    await expect(
      clients[2]!.submitPhoneVerification({
        phone: "13800138000",
        code: "123456",
        trackingId: "staff-fixture",
      }),
    ).rejects.toMatchObject({ status: 429 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect([...db.state.counters.values()]).toEqual([2]);
  });

  it("does not call the provider if reserving the durable budget fails", async () => {
    const db = database();
    db.state.unavailable = true;
    const config = configuration(1);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const client = new AliyunSmsClient(
      config,
      new PhoneVerificationSmsBudgetService(config, db.prisma),
    );
    await expect(
      client.submitPhoneVerification({
        phone: "13800138000",
        code: "123456",
        trackingId: "unit-fixture",
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
