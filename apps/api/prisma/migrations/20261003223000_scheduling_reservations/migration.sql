CREATE TYPE "ShiftStatus" AS ENUM ('ACTIVE', 'CANCELLED');
CREATE TYPE "ReservationStatus" AS ENUM ('HOLD', 'CONFIRMED', 'RELEASED', 'EXPIRED');

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE "TherapistShift" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "therapistId" TEXT NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "status" "ShiftStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TherapistShift_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TherapistShift_range_check" CHECK ("startsAt" < "endsAt")
);

CREATE TABLE "AppointmentReservation" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "serviceId" TEXT NOT NULL,
  "therapistId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "status" "ReservationStatus" NOT NULL DEFAULT 'HOLD',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AppointmentReservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AppointmentReservation_range_check" CHECK ("startsAt" < "endsAt"),
  CONSTRAINT "AppointmentReservation_expiry_check" CHECK ("expiresAt" > "createdAt")
);

CREATE INDEX "TherapistShift_organizationId_startsAt_idx" ON "TherapistShift"("organizationId", "startsAt");
CREATE INDEX "TherapistShift_therapistId_status_startsAt_idx" ON "TherapistShift"("therapistId", "status", "startsAt");
CREATE INDEX "AppointmentReservation_organizationId_startsAt_idx" ON "AppointmentReservation"("organizationId", "startsAt");
CREATE INDEX "AppointmentReservation_therapistId_status_startsAt_idx" ON "AppointmentReservation"("therapistId", "status", "startsAt");
CREATE INDEX "AppointmentReservation_customerId_status_expiresAt_idx" ON "AppointmentReservation"("customerId", "status", "expiresAt");

ALTER TABLE "TherapistShift" ADD CONSTRAINT "TherapistShift_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TherapistShift" ADD CONSTRAINT "TherapistShift_therapistId_fkey" FOREIGN KEY ("therapistId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AppointmentReservation" ADD CONSTRAINT "AppointmentReservation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AppointmentReservation" ADD CONSTRAINT "AppointmentReservation_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AppointmentReservation" ADD CONSTRAINT "AppointmentReservation_therapistId_fkey" FOREIGN KEY ("therapistId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AppointmentReservation" ADD CONSTRAINT "AppointmentReservation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TherapistShift" ADD CONSTRAINT "TherapistShift_no_overlap"
  EXCLUDE USING gist (
    "therapistId" WITH =,
    tsrange("startsAt", "endsAt", '[)') WITH &&
  ) WHERE ("status" = 'ACTIVE');

ALTER TABLE "AppointmentReservation" ADD CONSTRAINT "AppointmentReservation_no_overlap"
  EXCLUDE USING gist (
    "therapistId" WITH =,
    tsrange("startsAt", "endsAt", '[)') WITH &&
  ) WHERE ("status" IN ('HOLD', 'CONFIRMED'));
