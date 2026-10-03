import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { PaymentProvider, PaymentStatus } from "@prisma/client";
import { PrismaService } from "../database/prisma.service.js";
import {
  RECOVERY_MAX_ATTEMPTS,
  WechatRecoveryService,
} from "./wechat-recovery.service.js";

@Injectable()
export class WechatRecoveryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WechatRecoveryWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  constructor(
    private readonly prisma: PrismaService,
    private readonly recovery: WechatRecoveryService,
  ) {}
  onModuleInit() {
    if (!this.recovery.enabled()) return;
    void this.run();
    this.timer = setInterval(() => void this.run(), 60_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async run(now = new Date()) {
    if (this.running || !this.recovery.enabled()) return 0;
    this.running = true;
    let count = 0;
    try {
      const rows = await this.prisma.payment.findMany({
        where: {
          provider: PaymentProvider.WECHAT,
          status: PaymentStatus.PENDING,
          recoveryReviewAt: null,
          recoveryAttempts: { lte: RECOVERY_MAX_ATTEMPTS },
          AND: [
            {
              OR: [
                { recoveryNextCheckAt: null },
                { recoveryNextCheckAt: { lte: now } },
              ],
            },
            {
              OR: [
                { recoveryLeaseUntil: null },
                { recoveryLeaseUntil: { lte: now } },
              ],
            },
          ],
        },
        orderBy: [
          { recoveryNextCheckAt: { sort: "asc", nulls: "first" } },
          { createdAt: "asc" },
        ],
        take: 10,
      });
      for (const row of rows) {
        try {
          if (await this.recovery.recover(row.id, new Date())) count++;
        } catch {
          this.logger.warn(
            "Original payment recovery deferred; no reservation released",
          );
        }
      }
    } catch {
      this.logger.error("Original payment recovery scan failed");
    } finally {
      this.running = false;
    }
    return count;
  }
}
