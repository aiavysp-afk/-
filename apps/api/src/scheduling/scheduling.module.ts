import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { AdminSchedulingController } from "./admin-scheduling.controller.js";
import { AvailabilityController } from "./availability.controller.js";
import { BookingHoldsController } from "./booking-holds.controller.js";
import { SchedulingService } from "./scheduling.service.js";
import { AdminConsoleController } from "./admin-console.controller.js";
import { AdminConsoleService } from "./admin-console.service.js";

@Module({
  imports: [AuthModule],
  controllers: [
    AvailabilityController,
    BookingHoldsController,
    AdminSchedulingController,
    AdminConsoleController,
  ],
  providers: [SchedulingService, AdminConsoleService],
})
export class SchedulingModule {}
