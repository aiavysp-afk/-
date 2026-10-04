import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { SafetyService } from "./safety.service.js";

@Injectable()
export class SafetyEscalationWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SafetyEscalationWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly safety: SafetyService) {}

  onModuleInit() {
    void this.run();
    this.timer = setInterval(() => void this.run(), 30_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async run(now = new Date()) {
    if (this.running) return 0;
    this.running = true;
    try {
      return await this.safety.escalateDue(now);
    } catch {
      this.logger.error("Safety incident escalation scan failed");
      return 0;
    } finally {
      this.running = false;
    }
  }
}
