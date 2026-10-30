import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { AdminCustomerDirectoryService } from "../customer-center/admin-customer-directory.service.js";
import { SimpleAdminController } from "./simple-admin.controller.js";
import { SimpleAdminService } from "./simple-admin.service.js";
import { TechnicianIntakeService } from "./technician-intake.service.js";
import {
  AdminTechnicianIntakeController,
  PublicTechnicianIntakeController,
} from "./technician-intake.controller.js";
import { TechnicianPhotoService } from "../technicians/technician-photo.service.js";

@Module({
  imports: [AuthModule],
  controllers: [
    SimpleAdminController,
    PublicTechnicianIntakeController,
    AdminTechnicianIntakeController,
  ],
  providers: [
    SimpleAdminService,
    AdminCustomerDirectoryService,
    TechnicianIntakeService,
    TechnicianPhotoService,
  ],
})
export class SimpleAdminModule {}
