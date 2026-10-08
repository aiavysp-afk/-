import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import {
  AdminCustomerCenterController,
  CustomerCenterController,
} from "./customer-center.controller.js";
import { CustomerCenterService } from "./customer-center.service.js";

@Module({
  imports: [AuthModule],
  controllers: [CustomerCenterController, AdminCustomerCenterController],
  providers: [CustomerCenterService],
  exports: [CustomerCenterService],
})
export class CustomerCenterModule {}
