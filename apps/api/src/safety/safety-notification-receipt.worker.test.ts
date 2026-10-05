import { describe, expect, it, vi } from "vitest";
import type { ConfigService } from "@nestjs/config";
import type { AppEnv } from "../config/env.js";
import type { AuthCryptoService } from "../auth/auth-crypto.service.js";
import type { PrismaService } from "../database/prisma.service.js";
import type { AliyunSmsClient } from "../integrations/aliyun-sms.client.js";
import {
  SAFETY_RECEIPT_MAX_ATTEMPTS,
  SafetyNotificationReceiptWorker,
} from "./safety-notification-receipt.worker.js";

function fixture(
  result:
    | { status: "PENDING" }
    | { status: "DELIVERED" }
    | { status: "FAILED"; errorCode: string }
    | { status: "UNKNOWN"; errorCode: string },
  attempts = 1,
) {
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const prisma = {
    outboxEvent: {
      updateMany,
      findUnique: vi.fn().mockResolvedValue({
        id: "outbox-1",
        aggregateId: "incident-1",
        type: "SAFETY_INCIDENT_OPENED",
        payload: {
          incidentId: "incident-1",
          primaryUserId: "duty-primary",
        },
        publishedAt: new Date("2026-10-05T01:00:00.000Z"),
        providerBizId: "biz-1",
        deliveryQueryAttempts: attempts,
      }),
    },
    safetyIncident: {
      findUnique: vi.fn().mockResolvedValue({
        id: "incident-1",
        primaryUserId: "duty-primary",
        backupUserId: "duty-backup",
      }),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({
        status: "ACTIVE",
        phoneEncrypted: "encrypted-phone",
      }),
    },
  } as unknown as PrismaService;
  const sms = {
    queryDelivery: vi.fn().mockResolvedValue(result),
  } as unknown as AliyunSmsClient;
  const worker = new SafetyNotificationReceiptWorker(
    prisma,
    {
      decrypt: vi.fn().mockReturnValue("13800138000"),
    } as unknown as AuthCryptoService,
    sms,
    {
      get: vi.fn().mockReturnValue("true"),
    } as unknown as ConfigService<AppEnv, true>,
  );
  return { worker, updateMany, sms };
}

const process = (
  worker: SafetyNotificationReceiptWorker,
  now = new Date("2026-10-05T01:05:00.000Z"),
) =>
  (
    worker as unknown as {
      process: (id: string, leaseToken: string, now: Date) => Promise<boolean>;
    }
  ).process("outbox-1", "lease-1", now);

describe("SafetyNotificationReceiptWorker", () => {
  it("records handset delivery separately from provider acceptance", async () => {
    const f = fixture({ status: "DELIVERED" });
    await expect(process(f.worker)).resolves.toBe(true);
    expect(f.sms.queryDelivery).toHaveBeenCalledWith({
      phone: "13800138000",
      bizId: "biz-1",
      sendDate: "20261005",
      trackingId: "outbox-1",
    });
    expect(f.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deliveryStatus: "DELIVERED",
          deliveredAt: new Date("2026-10-05T01:05:00.000Z"),
          deliveryNextQueryAt: null,
        }),
      }),
    );
  });

  it("records terminal carrier failure without resending the SMS", async () => {
    const f = fixture({
      status: "FAILED",
      errorCode: "SMS_DELIVERY_TEST_FAILURE",
    });
    await process(f.worker);
    expect(f.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deliveryStatus: "FAILED",
          deliveryErrorCode: "SMS_DELIVERY_TEST_FAILURE",
        }),
      }),
    );
  });

  it("backs off a pending receipt and never calls the submission method", async () => {
    const f = fixture({ status: "PENDING" }, 2);
    await process(f.worker);
    const lastUpdate = f.updateMany.mock.calls.at(-1)?.[0];
    expect(lastUpdate).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          deliveryNextQueryAt: new Date("2026-10-05T01:07:00.000Z"),
        }),
      }),
    );
    expect(lastUpdate?.data).not.toHaveProperty("deliveryStatus");
    expect(
      (f.sms as unknown as { submit?: ReturnType<typeof vi.fn> }).submit,
    ).toBeUndefined();
  });

  it("terminates an exhausted unknown result for manual review", async () => {
    const f = fixture(
      { status: "UNKNOWN", errorCode: "SMS_RECEIPT_QUERY_UNAVAILABLE" },
      SAFETY_RECEIPT_MAX_ATTEMPTS,
    );
    await process(f.worker);
    expect(f.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deliveryStatus: "UNKNOWN",
          deliveryErrorCode: "SMS_RECEIPT_QUERY_UNAVAILABLE",
          deliveryNextQueryAt: null,
        }),
      }),
    );
  });
});
