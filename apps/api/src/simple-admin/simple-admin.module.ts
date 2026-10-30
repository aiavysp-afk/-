import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { AdminCustomerDirectoryService } from "../customer-center/admin-customer-directory.service.js";
import { SimpleAdminController } from "./simple-admin.controller.js";
import { SimpleAdminService } from "./simple-admin.service.js";

@Module({
  imports: [AuthModule],
  controllers: [SimpleAdminController],
  providers: [SimpleAdminService, AdminCustomerDirectoryService],
})
export class SimpleAdminModule {}
