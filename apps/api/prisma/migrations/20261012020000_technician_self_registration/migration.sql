-- Additive: registration creates only a private draft, never staff permissions.
ALTER TABLE "TechnicianProfile" ADD COLUMN "selfRegistered" BOOLEAN NOT NULL DEFAULT false;
