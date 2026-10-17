-- Dedicated first-time setup proofs; no users, roles, passwords or MFA are seeded.
CREATE TABLE "StaffPasswordSetupChallenge" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "phoneHash" TEXT NOT NULL,
  "secretHash" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "consumedAt" TIMESTAMP(3),
  "providerRequestId" TEXT,
  "providerBizId" TEXT,
  CONSTRAINT "StaffPasswordSetupChallenge_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StaffPasswordSetupChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "StaffPasswordSetupChallenge_userId_createdAt_idx" ON "StaffPasswordSetupChallenge"("userId", "createdAt");
CREATE INDEX "StaffPasswordSetupChallenge_expiresAt_idx" ON "StaffPasswordSetupChallenge"("expiresAt");
