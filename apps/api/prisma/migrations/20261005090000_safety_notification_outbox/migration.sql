ALTER TABLE "OutboxEvent"
  ADD COLUMN "organizationId" TEXT,
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "leaseToken" TEXT,
  ADD COLUMN "leaseUntil" TIMESTAMP(3),
  ADD COLUMN "dispatchStartedAt" TIMESTAMP(3),
  ADD COLUMN "lastErrorCode" TEXT,
  ADD COLUMN "providerReference" TEXT,
  ADD COLUMN "deadLetteredAt" TIMESTAMP(3);

UPDATE "OutboxEvent" AS outbox
SET "organizationId" = incident."organizationId"
FROM "SafetyIncident" AS incident
WHERE outbox."aggregateId" = incident."id"
  AND outbox."type" LIKE 'SAFETY_INCIDENT_%';

ALTER TABLE "OutboxEvent"
  ADD CONSTRAINT "OutboxEvent_attempts_nonnegative"
  CHECK ("attempts" >= 0),
  ADD CONSTRAINT "OutboxEvent_lease_pair"
  CHECK (("leaseToken" IS NULL) = ("leaseUntil" IS NULL)),
  ADD CONSTRAINT "OutboxEvent_terminal_state"
  CHECK (NOT ("publishedAt" IS NOT NULL AND "deadLetteredAt" IS NOT NULL));

CREATE INDEX "OutboxEvent_organizationId_createdAt_idx"
  ON "OutboxEvent"("organizationId", "createdAt");

CREATE INDEX "OutboxEvent_dispatch_idx"
  ON "OutboxEvent"("publishedAt", "deadLetteredAt", "nextAttemptAt", "leaseUntil");
