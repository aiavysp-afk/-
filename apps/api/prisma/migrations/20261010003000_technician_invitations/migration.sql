CREATE TYPE "TechnicianInvitationStatus" AS ENUM ('PENDING', 'CLAIMED', 'REVOKED');

CREATE TABLE "TechnicianInvitation" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "publicName" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "status" "TechnicianInvitationStatus" NOT NULL DEFAULT 'PENDING',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdById" TEXT NOT NULL,
  "claimedById" TEXT,
  "claimedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TechnicianInvitation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TechnicianInvitation_expiry_check" CHECK (
    "expiresAt" > "createdAt" AND
    "expiresAt" <= "createdAt" + interval '7 days'
  ),
  CONSTRAINT "TechnicianInvitation_state_check" CHECK (
    ("status" = 'PENDING' AND "claimedById" IS NULL AND "claimedAt" IS NULL AND "revokedAt" IS NULL) OR
    ("status" = 'CLAIMED' AND "claimedById" IS NOT NULL AND "claimedAt" IS NOT NULL AND "revokedAt" IS NULL) OR
    ("status" = 'REVOKED' AND "claimedById" IS NULL AND "claimedAt" IS NULL AND "revokedAt" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "TechnicianInvitation_tokenHash_key"
  ON "TechnicianInvitation"("tokenHash");
CREATE INDEX "TechnicianInvitation_organizationId_status_expiresAt_idx"
  ON "TechnicianInvitation"("organizationId", "status", "expiresAt");
CREATE INDEX "TechnicianInvitation_claimedById_claimedAt_idx"
  ON "TechnicianInvitation"("claimedById", "claimedAt");

ALTER TABLE "TechnicianInvitation"
  ADD CONSTRAINT "TechnicianInvitation_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TechnicianInvitation"
  ADD CONSTRAINT "TechnicianInvitation_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TechnicianInvitation"
  ADD CONSTRAINT "TechnicianInvitation_claimedById_fkey"
  FOREIGN KEY ("claimedById") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION guard_technician_invitation() RETURNS trigger AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR
     NEW."organizationId" IS DISTINCT FROM OLD."organizationId" OR
     NEW."publicName" IS DISTINCT FROM OLD."publicName" OR
     NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash" OR
     NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" OR
     NEW."createdById" IS DISTINCT FROM OLD."createdById" OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'immutable technician invitation';
  END IF;
  IF OLD."status" <> 'PENDING' OR NEW."status" NOT IN ('PENDING', 'CLAIMED', 'REVOKED') THEN
    RAISE EXCEPTION 'invalid technician invitation transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TechnicianInvitation_guard"
BEFORE UPDATE ON "TechnicianInvitation"
FOR EACH ROW EXECUTE FUNCTION guard_technician_invitation();
