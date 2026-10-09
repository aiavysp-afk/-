import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { PrismaService } from "../database/prisma.service.js";
import { StoredValueRechargesService } from "./stored-value-recharges.service.js";

@Injectable()
export class StoredValueRechargeRecoveryWorker
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(StoredValueRechargeRecoveryWorker.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private cursor?: string;
  private ceiling?: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly recharges: StoredValueRechargesService,
  ) {}

  onModuleInit() {
    if (!this.recharges.recoveryEnabled()) return;
    void this.run();
    this.timer = setInterval(() => void this.run(), 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async run(now = new Date()) {
    if (this.running || !this.recharges.recoveryEnabled()) return 0;
    this.running = true;
    let recovered = 0;
    try {
      // Fix a high-water mark for each round so continuous new arrivals cannot
      // keep older unresolved originals from getting another turn. Query-only;
      // multiple replicas remain safe through existing transactional idempotency.
      const eligible = {
        status: { in: ["PENDING", "UNKNOWN"] as ("PENDING" | "UNKNOWN")[] },
        createdAt: { lte: new Date(now.getTime() - 30_000) },
        prepayState: {
          in: ["READY", "UNKNOWN", "DISPATCHING"] as (
            | "READY"
            | "UNKNOWN"
            | "DISPATCHING"
          )[],
        },
      };
      if (!this.ceiling) {
        const last = await this.prisma.storedValueRecharge.findFirst({
          where: eligible,
          orderBy: { id: "desc" },
          select: { id: true },
        });
        if (!last) return 0;
        this.ceiling = last.id;
      }
      const rows = await this.prisma.storedValueRecharge.findMany({
        where: {
          ...eligible,
          id: {
            lte: this.ceiling,
            ...(this.cursor ? { gt: this.cursor } : {}),
          },
        },
        orderBy: { id: "asc" },
        take: 10,
        select: { id: true },
      });
      for (const row of rows) {
        this.cursor = row.id;
        try {
          if (await this.recharges.recoverExisting(row.id)) recovered++;
        } catch {
          // Do not include provider payloads, identities or credentials in logs.
          this.logger.warn("充值原单查验未完成，保留原状态等待后续核对");
        }
      }
      if (!rows.length || this.cursor === this.ceiling) {
        this.cursor = undefined;
        this.ceiling = undefined;
      }
    } catch {
      this.logger.warn("充值原单查验扫描失败，未确认的资金保持不变");
    } finally {
      this.running = false;
    }
    return recovered;
  }
}
