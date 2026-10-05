import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { IntegrationsModule } from "../integrations/integrations.module.js";
import { SafetyEscalationWorker } from "./safety-escalation.worker.js";
import { SafetyController } from "./safety.controller.js";
import { SafetyNotificationDispatcher } from "./safety-notification.dispatcher.js";
import { SafetyNotificationService } from "./safety-notification.service.js";
import { SafetyNotificationWorker } from "./safety-notification.worker.js";
import { SafetyService } from "./safety.service.js";

@Module({
  imports: [AuthModule, IntegrationsModule],
  controllers: [SafetyController],
  providers: [
    SafetyService,
    SafetyEscalationWorker,
    SafetyNotificationDispatcher,
    SafetyNotificationService,
    SafetyNotificationWorker,
  ],
})
export class SafetyModule {}
