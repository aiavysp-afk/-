CREATE TYPE "MfaRecoveryStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED');

CREATE TABLE "MfaRecoveryRequest" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organizationId" TEXT NOT NULL REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "targetUserId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "sourceSessionId" TEXT NOT NULL,
  "status" "MfaRecoveryStatus" NOT NULL DEFAULT 'PENDING',
  "reviewerUserId" TEXT REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "reviewerSessionId" TEXT,
  "reasonCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "reviewedAt" TIMESTAMP(3),
  "executedAt" TIMESTAMP(3),
  CONSTRAINT "MfaRecoveryRequest_expiry_check" CHECK (
    "expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + interval '30 minutes'
  ),
  CONSTRAINT "MfaRecoveryRequest_reviewer_check" CHECK (
    "reviewerUserId" IS NULL OR "reviewerUserId" <> "targetUserId"
  ),
  CONSTRAINT "MfaRecoveryRequest_state_check" CHECK (
    ("status" = 'PENDING' AND "reviewerUserId" IS NULL AND "reviewerSessionId" IS NULL AND "reasonCode" IS NULL AND "reviewedAt" IS NULL AND "executedAt" IS NULL) OR
    ("status" = 'APPROVED' AND "reviewerUserId" IS NOT NULL AND "reviewerSessionId" IS NOT NULL AND "reasonCode" IS NULL AND "reviewedAt" IS NOT NULL AND "executedAt" IS NOT NULL) OR
    ("status" = 'REJECTED' AND "reviewerUserId" IS NOT NULL AND "reviewerSessionId" IS NOT NULL AND "reasonCode" IN ('IDENTITY_NOT_CONFIRMED','REQUEST_NOT_EXPECTED','POLICY_REVIEW_REQUIRED') AND "reviewedAt" IS NOT NULL AND "executedAt" IS NULL) OR
    ("status" = 'CANCELLED' AND "reviewerUserId" IS NULL AND "reviewerSessionId" IS NULL AND "reasonCode" = 'REQUESTER_CANCELLED' AND "reviewedAt" IS NOT NULL AND "executedAt" IS NULL) OR
    ("status" = 'EXPIRED' AND "reviewerUserId" IS NULL AND "reviewerSessionId" IS NULL AND "reasonCode" = 'EXPIRED' AND "reviewedAt" IS NOT NULL AND "executedAt" IS NULL)
  )
);

CREATE UNIQUE INDEX "MfaRecoveryRequest_one_pending_per_target"
  ON "MfaRecoveryRequest"("targetUserId") WHERE "status" = 'PENDING';
CREATE INDEX "MfaRecoveryRequest_organizationId_status_createdAt_idx"
  ON "MfaRecoveryRequest"("organizationId", "status", "createdAt");
CREATE INDEX "MfaRecoveryRequest_targetUserId_createdAt_idx"
  ON "MfaRecoveryRequest"("targetUserId", "createdAt");

CREATE FUNCTION guard_mfa_recovery_request() RETURNS trigger AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR
     NEW."organizationId" IS DISTINCT FROM OLD."organizationId" OR
     NEW."targetUserId" IS DISTINCT FROM OLD."targetUserId" OR
     NEW."sourceSessionId" IS DISTINCT FROM OLD."sourceSessionId" OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR
     NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" THEN
    RAISE EXCEPTION 'immutable MFA recovery request';
  END IF;
  IF OLD."status" <> 'PENDING' OR NEW."status" NOT IN ('PENDING','APPROVED','REJECTED','CANCELLED','EXPIRED') THEN
    RAISE EXCEPTION 'invalid MFA recovery transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MfaRecoveryRequest_guard" BEFORE UPDATE ON "MfaRecoveryRequest"
FOR EACH ROW EXECUTE FUNCTION guard_mfa_recovery_request();
