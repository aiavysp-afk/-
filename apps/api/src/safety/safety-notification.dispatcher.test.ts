import { describe, expect, it, vi } from "vitest";
import type { AuthCryptoService } from "../auth/auth-crypto.service.js";
import type { PrismaService } from "../database/prisma.service.js";
import type { AliyunSmsClient } from "../integrations/aliyun-sms.client.js";
import { SafetyNotificationDispatcher } from "./safety-notification.dispatcher.js";

function fixture(options?: {
  type?: string;
  target?: string;
  receipt?:
    | { status: "ACCEPTED"; requestId: string; bizId: string }
    | {
        status: "UNKNOWN";
      };
}) {
  const type = options?.type ?? "SAFETY_INCIDENT_OPENED";
  const target = options?.target ?? "duty-primary";
  const prisma = {
    outboxEvent: {
      findUnique: vi.fn().mockResolvedValue({
        id: "outbox-1",
        aggregateId: "incident-1",
        type,
        payload: {
          incidentId: "incident-1",
          primaryUserId: target,
          backupUserId: target,
        },
      }),
    },
    safetyIncident: {
      findUnique: vi.fn().mockResolvedValue({
        id: "incident-1",
        primaryUserId: "duty-primary",
        backupUserId: "duty-backup",
        category: "PERSONAL_SAFETY",
        acknowledgementDueAt: new Date("2026-10-05T09:02:00.000Z"),
        order: { orderNo: "ZY-SAFETY-1" },
      }),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({
        phoneEncrypted: "encrypted-phone",
        status: "ACTIVE",
      }),
    },
  } as unknown as PrismaService;
  const crypto = {
    decrypt: vi.fn().mockReturnValue("13800138000"),
  } as unknown as AuthCryptoService;
  const sms = {
    submit: vi.fn().mockResolvedValue(
      options?.receipt ?? {
        status: "ACCEPTED",
        requestId: "request-1",
        bizId: "biz-1",
      },
    ),
  } as unknown as AliyunSmsClient;
  return {
    dispatcher: new SafetyNotificationDispatcher(prisma, crypto, sms),
    sms,
  };
}

describe("SafetyNotificationDispatcher", () => {
  it("records provider acceptance without treating it as handset delivery", async () => {
    const f = fixture();
    await expect(f.dispatcher.dispatch("outbox-1")).resolves.toEqual({
      outcome: "ACCEPTED",
      providerReference: "request-1:biz-1",
    });
    expect(f.sms.submit).toHaveBeenCalledWith({
      phone: "13800138000",
      trackingId: "outbox-1",
      parameters: {
        orderNo: "ZY-SAFETY-1",
        category: "PERSONAL_SAFETY",
        stage: "PRIMARY",
        deadline: "2026-10-05T09:02:00.000Z",
      },
    });
  });

  it("dead-letters an unknown provider outcome instead of blindly resending", async () => {
    const f = fixture({ receipt: { status: "UNKNOWN" } });
    await expect(f.dispatcher.dispatch("outbox-1")).resolves.toEqual({
      outcome: "DEAD_LETTER",
      errorCode: "SMS_ACCEPTANCE_UNKNOWN",
    });
  });

  it("rejects a payload target that differs from the incident snapshot", async () => {
    const f = fixture({ target: "unexpected-user" });
    await expect(f.dispatcher.dispatch("outbox-1")).resolves.toEqual({
      outcome: "DEAD_LETTER",
      errorCode: "TARGET_MISMATCH",
    });
    expect(f.sms.submit).not.toHaveBeenCalled();
  });
});
