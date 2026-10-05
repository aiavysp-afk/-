import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppEnv } from "../config/env.js";
import { AuthCryptoService } from "../auth/auth-crypto.service.js";
import { PrismaService } from "../database/prisma.service.js";
import { AliyunSmsClient } from "../integrations/aliyun-sms.client.js";

const EVENT_TYPES = ["SAFETY_INCIDENT_OPENED", "SAFETY_INCIDENT_ESCALATED"];
const Payload = z.object({
  incidentId: z.string().min(1),
  primaryUserId: z.string().min(1).optional(),
  backupUserId: z.string().min(1).optional(),
});
export const SAFETY_RECEIPT_MAX_ATTEMPTS = 48;
const RECEIPT_QUERY_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

@Injectable()
export class SafetyNotificationReceiptWorker
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(SafetyNotificationReceiptWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: AuthCryptoService,
    private readonly sms: AliyunSmsClient,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  enabled() {
    return (
      this.config.get("SAFETY_NOTIFICATION_RECEIPT_QUERY_ENABLED", {
        infer: true,
      }) === "true"
    );
  }

  onModuleInit() {
    if (!this.enabled()) return;
    void this.run();
    this.timer = setInterval(() => void this.run(), 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async run(now = new Date(), limit = 20) {
    if (this.running || !this.enabled()) return 0;
    this.running = true;
    try {
      const claimed = await this.claim(now, limit);
      let processed = 0;
      for (const item of claimed) {
        if (await this.process(item.id, item.leaseToken, now)) processed++;
      }
      return processed;
    } catch {
      this.logger.error("Safety notification delivery receipt scan failed");
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async claim(now: Date, limit: number) {
    const batchSize = Math.max(1, Math.min(limit, 100));
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "OutboxEvent"
        WHERE "type" IN ('SAFETY_INCIDENT_OPENED', 'SAFETY_INCIDENT_ESCALATED')
          AND "publishedAt" IS NOT NULL
          AND "deliveryStatus" = 'PENDING'
          AND "deliveryNextQueryAt" <= ${now}
          AND ("leaseUntil" IS NULL OR "leaseUntil" <= ${now})
        ORDER BY "deliveryNextQueryAt" ASC, "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${batchSize}
      `;
      const ids = rows.map((row) => row.id);
      if (!ids.length) return [];
      const leaseToken = randomUUID();
      await tx.outboxEvent.updateMany({
        where: { id: { in: ids } },
        data: {
          leaseToken,
          leaseUntil: new Date(now.getTime() + 30_000),
        },
      });
      return ids.map((id) => ({ id, leaseToken }));
    });
  }

  private async process(id: string, leaseToken: string, now: Date) {
    const started = await this.prisma.outboxEvent.updateMany({
      where: { id, leaseToken, deliveryStatus: "PENDING" },
      data: { deliveryQueryAttempts: { increment: 1 } },
    });
    if (started.count !== 1) return false;
    const event = await this.prisma.outboxEvent.findUnique({ where: { id } });
    if (!event?.publishedAt || !event.providerBizId)
      return this.finishUnknown(id, leaseToken, now, "RECEIPT_DATA_MISSING");
    if (event.deliveryQueryAttempts > SAFETY_RECEIPT_MAX_ATTEMPTS)
      return this.finishUnknown(
        id,
        leaseToken,
        now,
        "SMS_RECEIPT_QUERY_EXHAUSTED",
      );
    if (
      now.getTime() - event.publishedAt.getTime() >= RECEIPT_QUERY_WINDOW_MS
    )
      return this.finishUnknown(
        id,
        leaseToken,
        now,
        "SMS_RECEIPT_QUERY_WINDOW_EXPIRED",
      );
    const payload = Payload.safeParse(event.payload);
    if (!payload.success)
      return this.finishUnknown(id, leaseToken, now, "RECEIPT_PAYLOAD_INVALID");
    const incident = await this.prisma.safetyIncident.findUnique({
      where: { id: payload.data.incidentId },
      select: { id: true, primaryUserId: true, backupUserId: true },
    });
    if (!incident || incident.id !== event.aggregateId)
      return this.finishUnknown(
        id,
        leaseToken,
        now,
        "RECEIPT_INCIDENT_MISSING",
      );
    const targetUserId =
      event.type === "SAFETY_INCIDENT_OPENED"
        ? payload.data.primaryUserId
        : event.type === "SAFETY_INCIDENT_ESCALATED"
          ? payload.data.backupUserId
          : undefined;
    const expectedUserId =
      event.type === "SAFETY_INCIDENT_OPENED"
        ? incident.primaryUserId
        : incident.backupUserId;
    if (!targetUserId || targetUserId !== expectedUserId)
      return this.finishUnknown(id, leaseToken, now, "RECEIPT_TARGET_MISMATCH");
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { phoneEncrypted: true, status: true },
    });
    let phone = "";
    try {
      if (!target || target.status !== "ACTIVE" || !target.phoneEncrypted)
        throw Error("missing");
      phone = this.crypto.decrypt(target.phoneEncrypted);
    } catch {
      return this.finishUnknown(id, leaseToken, now, "RECEIPT_PHONE_INVALID");
    }
    if (!/^1[3-9]\d{9}$/.test(phone))
      return this.finishUnknown(id, leaseToken, now, "RECEIPT_PHONE_INVALID");

    let result;
    try {
      result = await this.sms.queryDelivery({
        phone,
        bizId: event.providerBizId,
        sendDate: chinaDate(event.publishedAt),
        trackingId: event.id,
      });
    } catch {
      result = {
        status: "UNKNOWN" as const,
        errorCode: "SMS_RECEIPT_QUERY_NOT_READY",
      };
    }
    if (result.status === "DELIVERED") {
      await this.prisma.outboxEvent.updateMany({
        where: { id, leaseToken, deliveryStatus: "PENDING" },
        data: {
          deliveryStatus: "DELIVERED",
          deliveryCheckedAt: now,
          deliveredAt: now,
          deliveryNextQueryAt: null,
          deliveryErrorCode: null,
          leaseToken: null,
          leaseUntil: null,
        },
      });
      return true;
    }
    if (result.status === "FAILED") {
      await this.prisma.outboxEvent.updateMany({
        where: { id, leaseToken, deliveryStatus: "PENDING" },
        data: {
          deliveryStatus: "FAILED",
          deliveryCheckedAt: now,
          deliveryNextQueryAt: null,
          deliveryErrorCode: result.errorCode,
          leaseToken: null,
          leaseUntil: null,
        },
      });
      return true;
    }
    if (event.deliveryQueryAttempts >= SAFETY_RECEIPT_MAX_ATTEMPTS)
      return this.finishUnknown(
        id,
        leaseToken,
        now,
        result.status === "UNKNOWN"
          ? result.errorCode
          : "SMS_RECEIPT_QUERY_EXHAUSTED",
      );
    const delaySeconds = Math.min(
      60 * 2 ** Math.max(0, event.deliveryQueryAttempts - 1),
      1_800,
    );
    await this.prisma.outboxEvent.updateMany({
      where: { id, leaseToken, deliveryStatus: "PENDING" },
      data: {
        deliveryCheckedAt: now,
        deliveryNextQueryAt: new Date(now.getTime() + delaySeconds * 1_000),
        deliveryErrorCode:
          result.status === "UNKNOWN" ? result.errorCode : null,
        leaseToken: null,
        leaseUntil: null,
      },
    });
    return true;
  }

  private async finishUnknown(
    id: string,
    leaseToken: string,
    now: Date,
    errorCode: string,
  ) {
    await this.prisma.outboxEvent.updateMany({
      where: { id, leaseToken, deliveryStatus: "PENDING" },
      data: {
        deliveryStatus: "UNKNOWN",
        deliveryCheckedAt: now,
        deliveryNextQueryAt: null,
        deliveryErrorCode: errorCode,
        leaseToken: null,
        leaseUntil: null,
      },
    });
    return true;
  }
}

const chinaDate = (date: Date) => {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1_000);
  return [
    shifted.getUTCFullYear(),
    String(shifted.getUTCMonth() + 1).padStart(2, "0"),
    String(shifted.getUTCDate()).padStart(2, "0"),
  ].join("");
};
