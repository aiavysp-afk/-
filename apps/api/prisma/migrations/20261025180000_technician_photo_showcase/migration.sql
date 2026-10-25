-- Explicit publication of one portrait does not approve an application or grant booking access.
ALTER TABLE "TechnicianProfile" ADD COLUMN "showcasePhotoId" TEXT;
