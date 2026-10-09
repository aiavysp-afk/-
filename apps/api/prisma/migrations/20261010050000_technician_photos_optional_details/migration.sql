ALTER TABLE "TechnicianProfile" ALTER COLUMN "publicName" SET DEFAULT '';
ALTER TABLE "TechnicianProfile" ADD COLUMN "ageRange" TEXT;
ALTER TABLE "TechnicianProfile" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "TechnicianProfile" ADD CONSTRAINT "TechnicianProfile_ageRange_check"
  CHECK ("ageRange" IS NULL OR "ageRange" IN ('18-23岁', '24-29岁', '30-39岁', '40岁及以上'));

CREATE TABLE "TechnicianPhoto" (
  "id" TEXT NOT NULL,
  "profileId" TEXT NOT NULL,
  "digest" TEXT NOT NULL,
  "content" BYTEA NOT NULL,
  "width" INTEGER NOT NULL,
  "height" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TechnicianPhoto_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TechnicianPhoto_content_check" CHECK (octet_length("content") BETWEEN 1 AND 524288),
  CONSTRAINT "TechnicianPhoto_dimensions_check" CHECK ("width" BETWEEN 1 AND 1600 AND "height" BETWEEN 1 AND 1600)
);
CREATE UNIQUE INDEX "TechnicianPhoto_profileId_digest_key" ON "TechnicianPhoto"("profileId", "digest");
CREATE INDEX "TechnicianPhoto_profileId_createdAt_idx" ON "TechnicianPhoto"("profileId", "createdAt");
ALTER TABLE "TechnicianPhoto" ADD CONSTRAINT "TechnicianPhoto_profileId_fkey"
  FOREIGN KEY ("profileId") REFERENCES "TechnicianProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
