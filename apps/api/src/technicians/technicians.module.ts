import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import {
  AdminTechnicianProfileController,
  AdminTechnicianReviewsController,
  PublicTechniciansController,
  TechnicianProfileController,
  TechnicianReviewsController,
} from "./technicians.controller.js";
import { TechniciansService } from "./technicians.service.js";

@Module({
  imports: [AuthModule],
  controllers: [
    PublicTechniciansController,
    TechnicianProfileController,
    AdminTechnicianProfileController,
    AdminTechnicianReviewsController,
    TechnicianReviewsController,
  ],
  providers: [TechniciansService],
  exports: [TechniciansService],
})
export class TechniciansModule {}
