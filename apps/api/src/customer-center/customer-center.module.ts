import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import {
  AdminCustomerCenterController,
  CustomerCenterController,
} from "./customer-center.controller.js";
import { CustomerCenterService } from "./customer-center.service.js";
import { CustomerCouponsService } from "./customer-coupons.service.js";
import { AdminStoredValueLedgerService } from "./admin-stored-value-ledger.service.js";

@Module({
  imports: [AuthModule],
  controllers: [CustomerCenterController, AdminCustomerCenterController],
  providers: [
    CustomerCenterService,
    CustomerCouponsService,
    AdminStoredValueLedgerService,
  ],
  exports: [CustomerCenterService],
})
export class CustomerCenterModule {}
