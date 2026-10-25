import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import {
  AdminCustomerCenterController,
  CustomerCenterController,
} from "./customer-center.controller.js";
import { CustomerCenterService } from "./customer-center.service.js";
import { CustomerCouponsService } from "./customer-coupons.service.js";
import { AdminStoredValueLedgerService } from "./admin-stored-value-ledger.service.js";
import { AdminCustomerDirectoryController } from "./admin-customer-directory.controller.js";
import { AdminCustomerDirectoryService } from "./admin-customer-directory.service.js";
import { HomeCampaignService } from "./home-campaign.service.js";
import { HomeCampaignController, AdminHomeCampaignController } from "./home-campaign.controller.js";
import { TechnicianPhotoService } from "../technicians/technician-photo.service.js";

@Module({
  imports: [AuthModule],
  controllers: [
    CustomerCenterController,
    AdminCustomerCenterController,
    AdminCustomerDirectoryController,
    HomeCampaignController,
    AdminHomeCampaignController,
  ],
  providers: [
    CustomerCenterService,
    CustomerCouponsService,
    AdminStoredValueLedgerService,
    AdminCustomerDirectoryService,
    HomeCampaignService,
    TechnicianPhotoService,
  ],
  exports: [CustomerCenterService],
})
export class CustomerCenterModule {}
