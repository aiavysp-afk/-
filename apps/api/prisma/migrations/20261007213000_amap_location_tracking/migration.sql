ALTER TABLE "AddressVerification"
  ADD COLUMN "latitude" DOUBLE PRECISION,
  ADD COLUMN "longitude" DOUBLE PRECISION,
  ADD COLUMN "coordinateSystem" TEXT NOT NULL DEFAULT 'GCJ-02';

-- Existing verifications did not bind a coordinate and are short-lived. They
-- cannot be trusted for the new coordinate-bound order flow, so invalidate them.
DELETE FROM "AddressVerification";

ALTER TABLE "AddressVerification"
  ALTER COLUMN "latitude" SET NOT NULL,
  ALTER COLUMN "longitude" SET NOT NULL,
  ADD CONSTRAINT "AddressVerification_latitude_check" CHECK ("latitude" BETWEEN -90 AND 90),
  ADD CONSTRAINT "AddressVerification_longitude_check" CHECK ("longitude" BETWEEN -180 AND 180),
  ADD CONSTRAINT "AddressVerification_coordinate_system_check" CHECK ("coordinateSystem" = 'GCJ-02');

ALTER TABLE "Order"
  ADD COLUMN "addressLatitude" DOUBLE PRECISION,
  ADD COLUMN "addressLongitude" DOUBLE PRECISION,
  ADD COLUMN "addressCoordinateSystem" TEXT,
  ADD CONSTRAINT "Order_address_coordinate_pair_check" CHECK (
    ("addressLatitude" IS NULL AND "addressLongitude" IS NULL AND "addressCoordinateSystem" IS NULL)
    OR
    ("addressLatitude" BETWEEN -90 AND 90 AND "addressLongitude" BETWEEN -180 AND 180 AND "addressCoordinateSystem" = 'GCJ-02')
  );

CREATE TABLE "TechnicianLocation" (
  "id" TEXT NOT NULL,
  "technicianId" TEXT NOT NULL,
  "latitude" DOUBLE PRECISION NOT NULL,
  "longitude" DOUBLE PRECISION NOT NULL,
  "coordinateSystem" TEXT NOT NULL DEFAULT 'GCJ-02',
  "accuracyMeters" DOUBLE PRECISION,
  "reportedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TechnicianLocation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TechnicianLocation_latitude_check" CHECK ("latitude" BETWEEN -90 AND 90),
  CONSTRAINT "TechnicianLocation_longitude_check" CHECK ("longitude" BETWEEN -180 AND 180),
  CONSTRAINT "TechnicianLocation_accuracy_check" CHECK ("accuracyMeters" IS NULL OR "accuracyMeters" BETWEEN 0 AND 10000),
  CONSTRAINT "TechnicianLocation_coordinate_system_check" CHECK ("coordinateSystem" = 'GCJ-02')
);

CREATE UNIQUE INDEX "TechnicianLocation_technicianId_key" ON "TechnicianLocation"("technicianId");
CREATE INDEX "TechnicianLocation_reportedAt_idx" ON "TechnicianLocation"("reportedAt");

ALTER TABLE "TechnicianLocation"
  ADD CONSTRAINT "TechnicianLocation_technicianId_fkey"
  FOREIGN KEY ("technicianId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
