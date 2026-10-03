ALTER TABLE "Session" ADD COLUMN "mfaVerifiedUntil" TIMESTAMP(3);
ALTER TABLE "Session" ADD CONSTRAINT "Session_mfa_expiry" CHECK ("mfaVerifiedUntil" IS NULL OR "mfaVerifiedUntil" <= "expiresAt");
CREATE TABLE "MfaCredential" (
  "userId" TEXT NOT NULL PRIMARY KEY REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "secretEncrypted" TEXT NOT NULL,
  "enabledAt" TIMESTAMP(3),
  "enrollmentSessionId" TEXT,
  "enrollmentExpiresAt" TIMESTAMP(3),
  "lastAcceptedStep" BIGINT,
  "failedAttempts" INTEGER NOT NULL DEFAULT 0,
  "lockedUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Mfa_state" CHECK (
    ("enabledAt" IS NULL AND "enrollmentSessionId" IS NOT NULL AND length("enrollmentSessionId") > 0 AND "enrollmentExpiresAt" IS NOT NULL AND "lastAcceptedStep" IS NULL)
    OR ("enabledAt" IS NOT NULL AND "enrollmentSessionId" IS NULL AND "enrollmentExpiresAt" IS NULL AND "lastAcceptedStep" IS NOT NULL AND "lastAcceptedStep" >= 0)
  ),
  CONSTRAINT "Mfa_attempts" CHECK (
    ("failedAttempts" BETWEEN 0 AND 4 AND "lockedUntil" IS NULL)
    OR ("failedAttempts" = 5 AND "lockedUntil" IS NOT NULL)
  )
);
CREATE FUNCTION guard_active_mfa() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."enabledAt" IS NOT NULL AND (
    NEW."enabledAt" IS DISTINCT FROM OLD."enabledAt" OR NEW."secretEncrypted" IS DISTINCT FROM OLD."secretEncrypted"
    OR NEW."lastAcceptedStep" IS NULL OR NEW."lastAcceptedStep" < OLD."lastAcceptedStep"
  ) THEN RAISE EXCEPTION 'Active MFA cannot be silently replaced, disabled or replayed'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Mfa_active_guard" BEFORE UPDATE ON "MfaCredential" FOR EACH ROW EXECUTE FUNCTION guard_active_mfa();
