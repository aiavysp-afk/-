CREATE TABLE "PhoneVerificationChallenge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "phoneHash" TEXT NOT NULL,
    "phoneEncrypted" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "providerRequestId" TEXT,
    "providerBizId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PhoneVerificationChallenge_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PhoneVerificationRateLimit" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PhoneVerificationRateLimit_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "PhoneVerificationChallenge_userId_createdAt_idx" ON "PhoneVerificationChallenge"("userId", "createdAt");
CREATE INDEX "PhoneVerificationChallenge_phoneHash_createdAt_idx" ON "PhoneVerificationChallenge"("phoneHash", "createdAt");
CREATE INDEX "PhoneVerificationChallenge_status_expiresAt_idx" ON "PhoneVerificationChallenge"("status", "expiresAt");
CREATE INDEX "PhoneVerificationRateLimit_expiresAt_idx" ON "PhoneVerificationRateLimit"("expiresAt");

ALTER TABLE "PhoneVerificationChallenge" ADD CONSTRAINT "PhoneVerificationChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
