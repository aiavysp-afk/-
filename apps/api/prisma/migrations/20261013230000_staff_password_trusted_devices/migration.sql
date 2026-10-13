ALTER TABLE "Session" ADD COLUMN "staffVerifiedUntil" TIMESTAMP(3),
  ADD COLUMN "staffVerificationMethod" TEXT,
  ADD COLUMN "staffPasswordVersion" INTEGER,
  ADD COLUMN "trustedDeviceId" TEXT;

-- Preserve legacy/WeChat provenance and allow the new provider only on the
-- backend browser channel. Miniapp or H5 cannot claim password authority.
ALTER TABLE "Session" DROP CONSTRAINT "Session_auth_provenance_check";
ALTER TABLE "Session" ADD CONSTRAINT "Session_auth_provenance_check" CHECK (
  ("authChannel" = 'LEGACY' AND "authProvider" = 'unknown') OR
  ("authChannel" IN ('WECHAT_MINIAPP', 'ADMIN_BROWSER') AND "authProvider" IN ('wechat', 'mock')) OR
  ("authChannel" = 'ADMIN_BROWSER' AND "authProvider" = 'staff-password')
);

CREATE TABLE "StaffPasswordCredential" (
  "userId" TEXT NOT NULL,
  "phoneHash" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "failedAttempts" INTEGER NOT NULL DEFAULT 0,
  "lockedUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StaffPasswordCredential_pkey" PRIMARY KEY ("userId"),
  CONSTRAINT "StaffPasswordCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "StaffPasswordCredential_phoneHash_key" ON "StaffPasswordCredential"("phoneHash");

CREATE TABLE "StaffPasswordLoginChallenge" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "secretHash" TEXT NOT NULL,
  "passwordVersion" INTEGER NOT NULL,
  "phoneHash" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "consumedAt" TIMESTAMP(3),
  "providerRequestId" TEXT,
  "providerBizId" TEXT,
  CONSTRAINT "StaffPasswordLoginChallenge_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StaffPasswordLoginChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "StaffPasswordLoginChallenge_userId_createdAt_idx" ON "StaffPasswordLoginChallenge"("userId", "createdAt");
CREATE INDEX "StaffPasswordLoginChallenge_expiresAt_idx" ON "StaffPasswordLoginChallenge"("expiresAt");

CREATE TABLE "StaffTrustedDevice" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "userAgentHash" TEXT NOT NULL,
  "label" TEXT NOT NULL DEFAULT '常用设备',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "lastUsedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "mfaEnabledAtSnapshot" TIMESTAMP(3) NOT NULL,
  "passwordVersion" INTEGER NOT NULL DEFAULT 0,
  "phoneHash" TEXT NOT NULL,
  CONSTRAINT "StaffTrustedDevice_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StaffTrustedDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "StaffTrustedDevice_tokenHash_key" ON "StaffTrustedDevice"("tokenHash");
CREATE INDEX "StaffTrustedDevice_userId_revokedAt_expiresAt_idx" ON "StaffTrustedDevice"("userId", "revokedAt", "expiresAt");
CREATE INDEX "Session_trustedDeviceId_idx" ON "Session"("trustedDeviceId");
ALTER TABLE "Session" ADD CONSTRAINT "Session_trustedDeviceId_fkey" FOREIGN KEY ("trustedDeviceId") REFERENCES "StaffTrustedDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
