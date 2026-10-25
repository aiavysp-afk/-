CREATE TABLE "HomeCampaign" (
  "organizationId" TEXT NOT NULL PRIMARY KEY,
  "version" INTEGER NOT NULL DEFAULT 0,
  "content" JSONB NOT NULL,
  "imageBytes" BYTEA,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HomeCampaign_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
