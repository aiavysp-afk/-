import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import type { AppEnv } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { SafetyNotificationDispatcher } from "./safety-notification.dispatcher.js";

const EVENT_TYPES = ["SAFETY_INCIDENT_OPENED", "SAFETY_INCIDENT_ESCALATED"];
export const SAFETY_NOTIFICATION_MAX_ATTEMPTS = 8;

@Injectable()
export class SafetyNotificationWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SafetyNotificationWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: SafetyNotificationDispatcher,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  enabled() {
    return (
      this.config.get("SAFETY_NOTIFICATION_DISPATCH_ENABLED", {
        infer: true,
      }) === "true"
    );
  }

  onModuleInit() {
    if (!this.enabled()) return;
    void this.run();
    this.timer = setInterval(() => void this.run(), 15_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async run(now = new Date(), limit = 20) {
    if (this.running || !this.enabled()) return 0;
    this.running = true;
    try {
      await this.quarantineAmbiguous(now);
      const claimed = await this.claim(now, limit);
      let processed = 0;
      for (const item of claimed) {
        if (await this.process(item.id, item.leaseToken, now)) processed++;
      }
      return processed;
    } catch {
      this.logger.error("Safety notification outbox scan failed");
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async quarantineAmbiguous(now: Date) {
    await this.prisma.outboxEvent.updateMany({
      where: {
        type: { in: EVENT_TYPES },
        publishedAt: null,
        deadLetteredAt: null,
        dispatchStartedAt: { not: null },
        leaseUntil: { lte: now },
      },
      data: {
        deadLetteredAt: now,
        lastErrorCode: "PREVIOUS_ATTEMPT_OUTCOME_UNKNOWN",
        leaseToken: null,
        leaseUntil: null,
      },
    });
  }

  private async claim(now: Date, limit: number) {
    const batchSize = Math.max(1, Math.min(limit, 100));
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "OutboxEvent"
        WHERE "type" IN ('SAFETY_INCIDENT_OPENED', 'SAFETY_INCIDENT_ESCALATED')
          AND "publishedAt" IS NULL
          AND "deadLetteredAt" IS NULL
          AND "dispatchStartedAt" IS NULL
          AND "nextAttemptAt" <= ${now}
          AND ("leaseUntil" IS NULL OR "leaseUntil" <= ${now})
        ORDER BY "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${batchSize}
      `;
      const ids = rows.map((row) => row.id);
      if (!ids.length) return [];
      const leaseToken = randomUUID();
      const leaseUntil = new Date(now.getTime() + 30_000);
      await tx.outboxEvent.updateMany({
        where: { id: { in: ids } },
        data: { leaseToken, leaseUntil },
      });
      return ids.map((id) => ({ id, leaseToken }));
    });
  }

  private async process(id: string, leaseToken: string, now: Date) {
    const started = await this.prisma.outboxEvent.updateMany({
      where: {
        id,
        leaseToken,
        publishedAt: null,
        deadLetteredAt: null,
        dispatchStartedAt: null,
      },
      data: { dispatchStartedAt: now, attempts: { increment: 1 } },
    });
    if (started.count !== 1) return false;
    let result;
    try {
      result = await this.dispatcher.dispatch(id);
    } catch {
      await this.deadLetter(id, leaseToken, now, "DISPATCH_EXCEPTION_UNKNOWN");
      return true;
    }
    if (result.outcome === "ACCEPTED") {
      await this.prisma.outboxEvent.updateMany({
        where: { id, leaseToken, publishedAt: null, deadLetteredAt: null },
        data: {
          publishedAt: now,
          providerReference: result.providerReference,
          providerBizId: result.providerBizId,
          deliveryStatus: "PENDING",
          deliveryNextQueryAt: new Date(now.getTime() + 60_000),
          deliveryQueryAttempts: 0,
          deliveryCheckedAt: null,
          deliveredAt: null,
          deliveryErrorCode: null,
          lastErrorCode: null,
          leaseToken: null,
          leaseUntil: null,
        },
      });
      return true;
    }
    if (result.outcome === "DEAD_LETTER") {
      await this.deadLetter(id, leaseToken, now, result.errorCode);
      return true;
    }
    const current = await this.prisma.outboxEvent.findUnique({
      where: { id },
      select: { attempts: true },
    });
    if (!current || current.attempts >= SAFETY_NOTIFICATION_MAX_ATTEMPTS) {
      await this.deadLetter(id, leaseToken, now, result.errorCode);
      return true;
    }
    const delaySeconds = Math.min(30 * 2 ** current.attempts, 900);
    await this.prisma.outboxEvent.updateMany({
      where: { id, leaseToken, publishedAt: null, deadLetteredAt: null },
      data: {
        nextAttemptAt: new Date(now.getTime() + delaySeconds * 1_000),
        lastErrorCode: result.errorCode,
        dispatchStartedAt: null,
        leaseToken: null,
        leaseUntil: null,
      },
    });
    return true;
  }

  private async deadLetter(
    id: string,
    leaseToken: string,
    now: Date,
    errorCode: string,
  ) {
    await this.prisma.outboxEvent.updateMany({
      where: { id, leaseToken, publishedAt: null, deadLetteredAt: null },
      data: {
        deadLetteredAt: now,
        lastErrorCode: errorCode,
        leaseToken: null,
        leaseUntil: null,
      },
    });
  }
}
