-- Additive migration: existing users and every order/wallet/coupon owner stay intact.
CREATE TABLE "CustomerPhoneIdentity" (
  "phoneHash" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomerPhoneIdentity_pkey" PRIMARY KEY ("phoneHash"),
  CONSTRAINT "CustomerPhoneIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CustomerPhoneIdentity_userId_key" ON "CustomerPhoneIdentity"("userId");

CREATE TABLE "CustomerSmsLoginChallenge" (
  "id" TEXT NOT NULL,
  "phoneHash" TEXT NOT NULL,
  "phoneEncrypted" TEXT NOT NULL,
  "requestIpHash" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "consumedAt" TIMESTAMP(3),
  "providerRequestId" TEXT,
  "providerBizId" TEXT,
  CONSTRAINT "CustomerSmsLoginChallenge_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomerSmsLoginChallenge_attempts_check" CHECK ("attempts" >= 0 AND "attempts" <= 5),
  CONSTRAINT "CustomerSmsLoginChallenge_status_check" CHECK ("status" IN ('PENDING', 'ACCEPTED', 'UNKNOWN', 'REJECTED', 'CONSUMED', 'EXPIRED'))
);
CREATE INDEX "CustomerSmsLoginChallenge_phoneHash_createdAt_idx" ON "CustomerSmsLoginChallenge"("phoneHash", "createdAt");
CREATE INDEX "CustomerSmsLoginChallenge_expiresAt_idx" ON "CustomerSmsLoginChallenge"("expiresAt");

ALTER TABLE "Session" ADD COLUMN "wechatIdentityId" TEXT;
ALTER TABLE "Session" ADD COLUMN "customerPhoneHash" TEXT;
-- A recharge replay belongs to the exact payer identity, not any OpenID of userId.
ALTER TABLE "StoredValueRecharge" ADD COLUMN "payerOpenIdHash" TEXT;
CREATE INDEX "Session_wechatIdentityId_idx" ON "Session"("wechatIdentityId");
ALTER TABLE "Session" ADD CONSTRAINT "Session_wechatIdentityId_fkey" FOREIGN KEY ("wechatIdentityId") REFERENCES "ExternalIdentity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Session" DROP CONSTRAINT "Session_auth_provenance_check";
ALTER TABLE "Session" ADD CONSTRAINT "Session_auth_provenance_check" CHECK (
  ("customerPhoneHash" IS NULL AND "authChannel" = 'LEGACY' AND "authProvider" = 'unknown') OR
  ("customerPhoneHash" IS NULL AND "authChannel" IN ('WECHAT_MINIAPP', 'ADMIN_BROWSER') AND "authProvider" IN ('wechat', 'mock')) OR
  ("customerPhoneHash" IS NULL AND "authChannel" = 'ADMIN_BROWSER' AND "authProvider" = 'staff-password') OR
  ("authChannel" = 'CUSTOMER_SMS' AND "authProvider" = 'customer-sms' AND "wechatIdentityId" IS NULL
   AND "customerPhoneHash" IS NOT NULL AND "customerPhoneHash" ~ '^[0-9a-f]{64}$'
   AND "mfaVerifiedUntil" IS NULL AND "staffVerifiedUntil" IS NULL AND "staffVerificationMethod" IS NULL
   AND "staffPasswordVersion" IS NULL AND "trustedDeviceId" IS NULL)
);
