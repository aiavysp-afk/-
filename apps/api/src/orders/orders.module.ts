import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { LocationsModule } from "../locations/locations.module.js";
import { OrderStateMachine } from "./order-state-machine.js";
import { OrdersController } from "./orders.controller.js";
import { OrdersService } from "./orders.service.js";

@Module({
  imports: [AuthModule, LocationsModule],
  controllers: [OrdersController],
  providers: [OrdersService, OrderStateMachine],
  exports: [OrdersService, OrderStateMachine],
})
export class OrdersModule {}
