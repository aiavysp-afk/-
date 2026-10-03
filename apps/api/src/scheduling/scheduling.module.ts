import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { AdminSchedulingController } from "./admin-scheduling.controller.js";
import { AvailabilityController } from "./availability.controller.js";
import { BookingHoldsController } from "./booking-holds.controller.js";
import { SchedulingService } from "./scheduling.service.js";

@Module({
  imports: [AuthModule],
  controllers: [
    AvailabilityController,
    BookingHoldsController,
    AdminSchedulingController,
  ],
  providers: [SchedulingService],
})
export class SchedulingModule {}
