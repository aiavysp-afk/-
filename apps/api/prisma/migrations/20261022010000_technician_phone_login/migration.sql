CREATE TABLE "TechnicianPhoneLoginChallenge" (
  "id" TEXT NOT NULL,
  "phoneHash" TEXT NOT NULL,
  "phoneEncrypted" TEXT NOT NULL,
  "requestIpHash" TEXT NOT NULL,
  "secretHash" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "consumedAt" TIMESTAMP(3),
  "providerRequestId" TEXT,
  "providerBizId" TEXT,
  CONSTRAINT "TechnicianPhoneLoginChallenge_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TechnicianPhoneLoginChallenge_attempts_check" CHECK ("attempts" >= 0 AND "attempts" <= 5)
);
CREATE INDEX "TechnicianPhoneLoginChallenge_phoneHash_createdAt_idx" ON "TechnicianPhoneLoginChallenge"("phoneHash", "createdAt");
CREATE INDEX "TechnicianPhoneLoginChallenge_expiresAt_idx" ON "TechnicianPhoneLoginChallenge"("expiresAt");

-- Preserve every branch of the canonical provenance allowlist verbatim, and
-- append the new low-authority phone channel. A separate scope CHECK alone
-- cannot make a source rejected by this pre-existing CHECK insertable.
ALTER TABLE "Session" DROP CONSTRAINT "Session_auth_provenance_check";
ALTER TABLE "Session" ADD CONSTRAINT "Session_auth_provenance_check" CHECK (
  ("customerPhoneHash" IS NULL AND "authChannel" = 'LEGACY' AND "authProvider" = 'unknown') OR
  ("customerPhoneHash" IS NULL AND "authChannel" IN ('WECHAT_MINIAPP', 'ADMIN_BROWSER') AND "authProvider" IN ('wechat', 'mock')) OR
  ("customerPhoneHash" IS NULL AND "authChannel" = 'ADMIN_BROWSER' AND "authProvider" = 'staff-password') OR
  ("authChannel" = 'CUSTOMER_SMS' AND "authProvider" = 'customer-sms' AND "wechatIdentityId" IS NULL
   AND "customerPhoneHash" IS NOT NULL AND "customerPhoneHash" ~ '^[0-9a-f]{64}$'
   AND "mfaVerifiedUntil" IS NULL AND "staffVerifiedUntil" IS NULL AND "staffVerificationMethod" IS NULL
   AND "staffPasswordVersion" IS NULL AND "trustedDeviceId" IS NULL) OR
  ("authChannel" IS NOT DISTINCT FROM 'TECHNICIAN_PHONE' AND "authProvider" IS NOT DISTINCT FROM 'technician-sms'
   AND "wechatIdentityId" IS NULL AND "customerPhoneHash" IS NOT NULL AND "customerPhoneHash" ~ '^[0-9a-f]{64}$'
   AND "mfaVerifiedUntil" IS NULL AND "staffVerifiedUntil" IS NULL AND "staffVerificationMethod" IS NULL
   AND "staffPasswordVersion" IS NULL AND "trustedDeviceId" IS NULL)
);

-- The new low-authority source cannot carry a management, MFA or WeChat grant.
-- No pre-existing session source or business row is rewritten.
ALTER TABLE "Session" ADD CONSTRAINT "Session_technician_phone_scope_check" CHECK (
  ("authChannel" IS DISTINCT FROM 'TECHNICIAN_PHONE' AND "authProvider" IS DISTINCT FROM 'technician-sms') OR
  ("authChannel" IS NOT DISTINCT FROM 'TECHNICIAN_PHONE' AND "authProvider" IS NOT DISTINCT FROM 'technician-sms'
    AND "customerPhoneHash" IS NOT NULL AND "wechatIdentityId" IS NULL
    AND "staffVerifiedUntil" IS NULL AND "staffVerificationMethod" IS NULL
    AND "staffPasswordVersion" IS NULL AND "trustedDeviceId" IS NULL
    AND "mfaVerifiedUntil" IS NULL)
);
