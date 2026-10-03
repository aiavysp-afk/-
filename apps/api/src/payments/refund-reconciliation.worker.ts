import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PaymentProvider, RefundStatus } from "@prisma/client";
import type { AppEnv } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { RefundsService } from "./refunds.service.js";

@Injectable()
export class RefundReconciliationWorker
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(RefundReconciliationWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  constructor(
    private readonly prisma: PrismaService,
    private readonly refunds: RefundsService,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}
  onModuleInit() {
    if (this.config.get("PAYMENT_PROVIDER", { infer: true }) !== "wechat")
      return;
    void this.run();
    this.timer = setInterval(() => void this.run(), 60_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async run(now = new Date()) {
    if (
      this.running ||
      this.config.get("PAYMENT_PROVIDER", { infer: true }) !== "wechat"
    )
      return 0;
    this.running = true;
    let claimed = 0;
    try {
      const rows = await this.prisma.refund.findMany({
        where: {
          payment: { provider: PaymentProvider.WECHAT },
          status: {
            in: [
              RefundStatus.PROCESSING,
              RefundStatus.UNKNOWN,
              RefundStatus.ABNORMAL,
            ],
          },
          submittedAt: { not: null },
          nextCheckAt: { lte: now },
          checkAttempts: { lt: 12 },
        },
        orderBy: { nextCheckAt: "asc" },
        take: 10,
      });
      for (const row of rows) {
        const attempts = row.checkAttempts + 1;
        // Claim a short lease atomically so multiple API processes don't poll the same job.
        const claim = await this.prisma.refund.updateMany({
          where: {
            id: row.id,
            status: row.status,
            nextCheckAt: { lte: now },
            checkAttempts: row.checkAttempts,
          },
          data: {
            checkAttempts: attempts,
            nextCheckAt: new Date(
              now.getTime() +
                Math.min(3600_000, 120_000 * 2 ** Math.min(attempts - 1, 5)),
            ),
          },
        });
        if (claim.count !== 1) continue;
        claimed++;
        try {
          await this.refunds.queryProvider(row.id);
        } catch {
          this.logger.warn(
            "Refund query remains unresolved; original refund number retained",
          );
        }
        if (attempts === 12) {
          await this.prisma.$transaction(async (tx) => {
            const unresolved = await tx.refund.updateMany({
              where: {
                id: row.id,
                status: {
                  in: [
                    RefundStatus.PROCESSING,
                    RefundStatus.UNKNOWN,
                    RefundStatus.ABNORMAL,
                  ],
                },
                checkAttempts: 12,
              },
              data: { nextCheckAt: null },
            });
            if (unresolved.count)
              await tx.outboxEvent.create({
                data: {
                  aggregateId: row.paymentId,
                  type: "REFUND_RECONCILIATION_REVIEW_REQUIRED",
                  payload: { refundId: row.id, paymentId: row.paymentId },
                },
              });
          });
        }
      }
      return claimed;
    } catch {
      this.logger.error("Refund reconciliation scan failed");
      return claimed;
    } finally {
      this.running = false;
    }
  }
}
