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
  TechnicianOnboardingController,
  AdminTechnicianApplicationsController,
  TechnicianH5OnboardingController,
} from "./technicians.controller.js";
import { TechnicianInvitationsService } from "./technician-invitations.service.js";
import { TechniciansService } from "./technicians.service.js";
import { TechnicianPhotoService } from "./technician-photo.service.js";
import { TechnicianPhoneOnboardingController } from "./technician-phone-onboarding.controller.js";

@Module({
  imports: [AuthModule],
  controllers: [
    TechnicianOnboardingController,
    TechnicianH5OnboardingController,
    TechnicianPhoneOnboardingController,
    AdminTechnicianApplicationsController,
    PublicTechniciansController,
    TechnicianInvitationsController,
    AdminTechnicianInvitationsController,
    TechnicianProfileController,
    AdminTechnicianProfileController,
    AdminTechnicianReviewsController,
    TechnicianReviewsController,
  ],
  providers: [TechniciansService, TechnicianInvitationsService, TechnicianPhotoService],
  exports: [TechniciansService],
})
export class TechniciansModule {}
