import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { LocationsModule } from "../locations/locations.module.js";
import { IntegrationsModule } from "../integrations/integrations.module.js";
import { OrderStateMachine } from "./order-state-machine.js";
import { OrderDispatchController } from "./order-dispatch.controller.js";
import { OrderDispatchService } from "./order-dispatch.service.js";
import { OrdersController } from "./orders.controller.js";
import { OrdersService } from "./orders.service.js";
import { OperationsDashboardController } from "./operations-dashboard.controller.js";
import { OperationsDashboardService } from "./operations-dashboard.service.js";
import { TechnicianWorkbenchController } from "./technician-workbench.controller.js";
import { TechnicianWorkbenchService } from "./technician-workbench.service.js";
import { TechnicianNotificationsService } from "./technician-notifications.service.js";
import { TechnicianNotificationsController } from "./technician-notifications.controller.js";

@Module({
  imports: [AuthModule, LocationsModule, IntegrationsModule],
  controllers: [
    TechnicianNotificationsController,
    OrdersController,
    OperationsDashboardController,
    TechnicianWorkbenchController,
    OrderDispatchController,
  ],
  providers: [
    TechnicianNotificationsService,
    OrdersService,
    OrderStateMachine,
    OperationsDashboardService,
    TechnicianWorkbenchService,
    OrderDispatchService,
  ],
  exports: [OrdersService, OrderStateMachine],
})
export class OrdersModule {}
