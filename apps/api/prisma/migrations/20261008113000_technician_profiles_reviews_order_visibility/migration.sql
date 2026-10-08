-- Technician profiles are centrally shared by the customer miniapp, technician
-- workbench and admin console. Only reviewed records may be made public.
CREATE TYPE "TechnicianProfileStatus" AS ENUM (
  'DRAFT',
  'PENDING_REVIEW',
  'APPROVED',
  'PUBLISHED',
  'REJECTED'
);

CREATE TYPE "TechnicianReviewStatus" AS ENUM ('PENDING_REVIEW', 'PUBLISHED', 'HIDDEN');

ALTER TABLE "Order" ADD COLUMN "customerHiddenAt" TIMESTAMP(3);

CREATE TABLE "TechnicianProfile" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "technicianId" TEXT NOT NULL,
  "publicName" TEXT NOT NULL,
  "avatarUrl" TEXT,
  "galleryUrls" JSONB NOT NULL DEFAULT '[]',
  "introduction" TEXT NOT NULL DEFAULT '',
  "specialties" JSONB NOT NULL DEFAULT '[]',
  "serviceYears" INTEGER,
  "certificates" JSONB NOT NULL DEFAULT '[]',
  "status" "TechnicianProfileStatus" NOT NULL DEFAULT 'DRAFT',
  "rejectionReason" TEXT,
  "reviewedById" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TechnicianProfile_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TechnicianProfile_serviceYears_check"
    CHECK ("serviceYears" IS NULL OR ("serviceYears" >= 0 AND "serviceYears" <= 60))
);

CREATE TABLE "TechnicianReview" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "technicianId" TEXT NOT NULL,
  "rating" INTEGER NOT NULL,
  "content" TEXT NOT NULL,
  "status" "TechnicianReviewStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TechnicianReview_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TechnicianReview_rating_check" CHECK ("rating" BETWEEN 1 AND 5)
);

CREATE UNIQUE INDEX "TechnicianProfile_technicianId_key"
  ON "TechnicianProfile"("technicianId");
CREATE INDEX "TechnicianProfile_organizationId_status_updatedAt_idx"
  ON "TechnicianProfile"("organizationId", "status", "updatedAt");
CREATE UNIQUE INDEX "TechnicianReview_orderId_key"
  ON "TechnicianReview"("orderId");
CREATE INDEX "TechnicianReview_technicianId_status_createdAt_idx"
  ON "TechnicianReview"("technicianId", "status", "createdAt");
CREATE INDEX "TechnicianReview_organizationId_status_createdAt_idx"
  ON "TechnicianReview"("organizationId", "status", "createdAt");
CREATE INDEX "TechnicianReview_customerId_createdAt_idx"
  ON "TechnicianReview"("customerId", "createdAt");
CREATE INDEX "Order_customerId_customerHiddenAt_createdAt_idx"
  ON "Order"("customerId", "customerHiddenAt", "createdAt");

ALTER TABLE "TechnicianProfile"
  ADD CONSTRAINT "TechnicianProfile_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TechnicianProfile"
  ADD CONSTRAINT "TechnicianProfile_technicianId_fkey"
  FOREIGN KEY ("technicianId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TechnicianProfile"
  ADD CONSTRAINT "TechnicianProfile_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TechnicianReview"
  ADD CONSTRAINT "TechnicianReview_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TechnicianReview"
  ADD CONSTRAINT "TechnicianReview_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TechnicianReview"
  ADD CONSTRAINT "TechnicianReview_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TechnicianReview"
  ADD CONSTRAINT "TechnicianReview_technicianId_fkey"
  FOREIGN KEY ("technicianId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
