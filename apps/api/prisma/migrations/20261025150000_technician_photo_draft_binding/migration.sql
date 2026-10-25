CREATE TABLE "TechnicianPhotoDraftBinding" (
  "sourceProfileId" TEXT NOT NULL PRIMARY KEY,
  "targetProfileId" TEXT NOT NULL UNIQUE,
  "createdById" TEXT NOT NULL,
  "copiedPhotos" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TechnicianPhotoDraftBinding_sourceProfileId_fkey" FOREIGN KEY ("sourceProfileId") REFERENCES "TechnicianProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TechnicianPhotoDraftBinding_targetProfileId_fkey" FOREIGN KEY ("targetProfileId") REFERENCES "TechnicianProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TechnicianPhotoDraftBinding_distinct_profiles" CHECK ("sourceProfileId" <> "targetProfileId")
);
