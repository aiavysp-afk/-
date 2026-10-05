CREATE TABLE "MapRequestRateLimit" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MapRequestRateLimit_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "MapRequestRateLimit_expiresAt_idx" ON "MapRequestRateLimit"("expiresAt");
