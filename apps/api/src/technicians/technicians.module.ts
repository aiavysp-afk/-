import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import {
  AdminTechnicianInvitationsController,
  AdminTechnicianProfileController,
  AdminTechnicianReviewsController,
  PublicTechniciansController,
  TechnicianInvitationsController,
  TechnicianProfileController,
  TechnicianReviewsController,
} from "./technicians.controller.js";
import { TechnicianInvitationsService } from "./technician-invitations.service.js";
import { TechniciansService } from "./technicians.service.js";

@Module({
  imports: [AuthModule],
  controllers: [
    PublicTechniciansController,
    TechnicianInvitationsController,
    AdminTechnicianInvitationsController,
    TechnicianProfileController,
    AdminTechnicianProfileController,
    AdminTechnicianReviewsController,
    TechnicianReviewsController,
  ],
  providers: [TechniciansService, TechnicianInvitationsService],
  exports: [TechniciansService],
})
export class TechniciansModule {}
