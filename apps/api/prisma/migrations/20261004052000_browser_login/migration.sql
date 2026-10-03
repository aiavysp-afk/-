ALTER TABLE "Session" ADD COLUMN "authChannel" TEXT NOT NULL DEFAULT 'LEGACY',
  ADD COLUMN "authProvider" TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE "Session" ADD CONSTRAINT "Session_auth_provenance_check" CHECK (
  ("authChannel" = 'LEGACY' AND "authProvider" = 'unknown') OR
  ("authChannel" IN ('WECHAT_MINIAPP','ADMIN_BROWSER') AND "authProvider" IN ('wechat','mock'))
);
CREATE TABLE "BrowserLoginChallenge" (
  "id" TEXT PRIMARY KEY,
  "browserSecretHash" TEXT NOT NULL,
  "confirmationHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "failedAttempts" INTEGER NOT NULL DEFAULT 0,
  "approvedUserId" TEXT,
  "approvedSessionId" TEXT,
  "claimedSessionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "approvedAt" TIMESTAMP(3),
  "consumedAt" TIMESTAMP(3),
  "lastPolledAt" TIMESTAMP(3),
  CONSTRAINT "BrowserLoginChallenge_expiry_check" CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + interval '3 minutes'),
  CONSTRAINT "BrowserLoginChallenge_attempts_check" CHECK ("failedAttempts" BETWEEN 0 AND 5),
  CONSTRAINT "BrowserLoginChallenge_state_check" CHECK (
    ("status" = 'PENDING' AND "approvedUserId" IS NULL AND "approvedSessionId" IS NULL AND "approvedAt" IS NULL AND "claimedSessionId" IS NULL AND "consumedAt" IS NULL AND "failedAttempts" < 5) OR
    ("status" = 'APPROVED' AND "approvedUserId" IS NOT NULL AND "approvedSessionId" IS NOT NULL AND "approvedAt" IS NOT NULL AND "claimedSessionId" IS NULL AND "consumedAt" IS NULL AND "failedAttempts" < 5) OR
    ("status" = 'CONSUMED' AND "approvedUserId" IS NOT NULL AND "approvedSessionId" IS NOT NULL AND "approvedAt" IS NOT NULL AND "claimedSessionId" IS NOT NULL AND "consumedAt" IS NOT NULL AND "failedAttempts" < 5) OR
    ("status" = 'CANCELLED' AND "claimedSessionId" IS NULL AND "consumedAt" IS NULL)
  )
);
CREATE UNIQUE INDEX "BrowserLoginChallenge_claimedSessionId_key" ON "BrowserLoginChallenge"("claimedSessionId");
CREATE INDEX "BrowserLoginChallenge_expiresAt_idx" ON "BrowserLoginChallenge"("expiresAt");
CREATE TABLE "BrowserLoginRateLimit" ("key" TEXT PRIMARY KEY, "count" INTEGER NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BrowserLoginRateLimit_count_check" CHECK ("count" > 0));
CREATE INDEX "BrowserLoginRateLimit_expiresAt_idx" ON "BrowserLoginRateLimit"("expiresAt");
CREATE FUNCTION guard_browser_login_challenge() RETURNS trigger AS $$
BEGIN
 IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."browserSecretHash" IS DISTINCT FROM OLD."browserSecretHash" OR
    NEW."confirmationHash" IS DISTINCT FROM OLD."confirmationHash" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR
    NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" OR NEW."failedAttempts" < OLD."failedAttempts" THEN
   RAISE EXCEPTION 'immutable browser login challenge';
 END IF;
 IF OLD."status" IN ('CONSUMED','CANCELLED') OR
    (OLD."status" = 'APPROVED' AND NEW."status" NOT IN ('APPROVED','CONSUMED','CANCELLED')) OR
    (OLD."status" = 'PENDING' AND NEW."status" NOT IN ('PENDING','APPROVED','CANCELLED')) THEN
   RAISE EXCEPTION 'invalid browser login transition';
 END IF;
 IF OLD."status" = 'APPROVED' AND (NEW."approvedUserId" IS DISTINCT FROM OLD."approvedUserId" OR
    NEW."approvedSessionId" IS DISTINCT FROM OLD."approvedSessionId" OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt") THEN
   RAISE EXCEPTION 'browser approval cannot be replaced';
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "BrowserLoginChallenge_guard" BEFORE UPDATE ON "BrowserLoginChallenge"
FOR EACH ROW EXECUTE FUNCTION guard_browser_login_challenge();
