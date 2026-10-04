import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { SafetyEscalationWorker } from "./safety-escalation.worker.js";
import { SafetyController } from "./safety.controller.js";
import { SafetyService } from "./safety.service.js";

@Module({
  imports: [AuthModule],
  controllers: [SafetyController],
  providers: [SafetyService, SafetyEscalationWorker],
})
export class SafetyModule {}
