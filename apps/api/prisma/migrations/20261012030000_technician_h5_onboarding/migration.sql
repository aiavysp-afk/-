ALTER TYPE "IdentityProvider" ADD VALUE IF NOT EXISTS 'WECHAT_H5';

CREATE TYPE "TechnicianIdentityDocumentKind" AS ENUM ('ID_FRONT', 'ID_BACK');

ALTER TABLE "TechnicianProfile"
  ADD COLUMN "registrationChannel" TEXT NOT NULL DEFAULT 'LEGACY',
  ADD COLUMN "realNameEncrypted" TEXT,
  ADD COLUMN "serviceCity" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "serviceAreas" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "availableTimeSlots" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "serviceIds" JSONB NOT NULL DEFAULT '[]';

-- Existing self-registration was available only through the mini-program.
-- Preserve that provenance instead of classifying historical applicants as
-- legacy/back-office records.
UPDATE "TechnicianProfile"
SET "registrationChannel" = 'WECHAT_MINIAPP'
WHERE "selfRegistered" = TRUE;

CREATE TABLE "TechnicianIdentityDocument" (
  "id" TEXT NOT NULL,
  "profileId" TEXT NOT NULL,
  "kind" "TechnicianIdentityDocumentKind" NOT NULL,
  "contentEncrypted" TEXT NOT NULL,
  "digest" TEXT NOT NULL,
  "width" INTEGER NOT NULL,
  "height" INTEGER NOT NULL,
  "mimeType" TEXT NOT NULL DEFAULT 'image/jpeg',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TechnicianIdentityDocument_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TechnicianIdentityDocument_profileId_kind_key"
  ON "TechnicianIdentityDocument"("profileId", "kind");
CREATE INDEX "TechnicianIdentityDocument_profileId_updatedAt_idx"
  ON "TechnicianIdentityDocument"("profileId", "updatedAt");
ALTER TABLE "TechnicianIdentityDocument"
  ADD CONSTRAINT "TechnicianIdentityDocument_profileId_fkey"
  FOREIGN KEY ("profileId") REFERENCES "TechnicianProfile"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TechnicianH5OAuthState" (
  "id" TEXT NOT NULL,
  "stateHash" TEXT NOT NULL,
  "browserBindingHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TechnicianH5OAuthState_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TechnicianH5OAuthState_stateHash_key"
  ON "TechnicianH5OAuthState"("stateHash");
CREATE INDEX "TechnicianH5OAuthState_expiresAt_idx"
  ON "TechnicianH5OAuthState"("expiresAt");

CREATE TABLE "TechnicianH5LoginTicket" (
  "id" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TechnicianH5LoginTicket_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TechnicianH5LoginTicket_tokenHash_key"
  ON "TechnicianH5LoginTicket"("tokenHash");
CREATE INDEX "TechnicianH5LoginTicket_userId_expiresAt_idx"
  ON "TechnicianH5LoginTicket"("userId", "expiresAt");
CREATE INDEX "TechnicianH5LoginTicket_expiresAt_idx"
  ON "TechnicianH5LoginTicket"("expiresAt");
ALTER TABLE "TechnicianH5LoginTicket"
  ADD CONSTRAINT "TechnicianH5LoginTicket_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing mini-program identities are backfilled only after proving that the
-- current data already has a one-UnionID/one-user invariant. Deployment stops
-- instead of silently guessing if historical identities conflict.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "ExternalIdentity"
    WHERE "unionIdHash" IS NOT NULL
    GROUP BY "unionIdHash"
    HAVING COUNT(DISTINCT "userId") > 1
  ) OR EXISTS (
    SELECT 1 FROM "ExternalIdentity"
    WHERE "unionIdHash" IS NOT NULL
    GROUP BY "userId"
    HAVING COUNT(DISTINCT "unionIdHash") > 1
  ) THEN
    RAISE EXCEPTION 'Conflicting historical WeChat UnionID bindings';
  END IF;
END $$;

CREATE TABLE "WechatUnionIdentity" (
  "unionIdHash" TEXT NOT NULL,
  "unionIdEncrypted" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WechatUnionIdentity_pkey" PRIMARY KEY ("unionIdHash")
);
CREATE UNIQUE INDEX "WechatUnionIdentity_userId_key"
  ON "WechatUnionIdentity"("userId");
ALTER TABLE "WechatUnionIdentity"
  ADD CONSTRAINT "WechatUnionIdentity_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "WechatUnionIdentity" (
  "unionIdHash", "unionIdEncrypted", "userId", "createdAt", "updatedAt"
)
SELECT DISTINCT ON ("unionIdHash")
  "unionIdHash", "unionIdEncrypted", "userId", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "ExternalIdentity"
WHERE "unionIdHash" IS NOT NULL AND "unionIdEncrypted" IS NOT NULL
ORDER BY "unionIdHash", "createdAt" ASC;
