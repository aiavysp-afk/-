import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { PaymentsService } from "./payments.service.js";

@Injectable()
export class PaymentExpiryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaymentExpiryWorker.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly payments: PaymentsService) {}

  onModuleInit() {
    void this.run();
    this.timer = setInterval(() => void this.run(), 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async run() {
    try {
      const expired = await this.payments.expirePendingOrders();
      if (expired)
        this.logger.log(`Closed ${expired} expired payment order(s)`);
    } catch (error) {
      this.logger.error(
        "Failed to close expired payment orders",
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
