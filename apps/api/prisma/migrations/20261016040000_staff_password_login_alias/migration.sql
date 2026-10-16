-- Optional login alias for an existing staff credential only. No users, roles,
-- credentials or default passwords are created or backfilled by this migration.
ALTER TABLE "StaffPasswordCredential" ADD COLUMN "loginAlias" TEXT;

-- PostgreSQL unique indexes allow multiple NULLs, preserving phone-only users.
CREATE UNIQUE INDEX "StaffPasswordCredential_loginAlias_key"
  ON "StaffPasswordCredential"("loginAlias");

ALTER TABLE "StaffPasswordCredential"
  ADD CONSTRAINT "StaffPasswordCredential_loginAlias_format_check" CHECK (
    "loginAlias" IS NULL OR "loginAlias" COLLATE "C" ~ '^[a-z][a-z0-9_-]{3,31}$'
  );
