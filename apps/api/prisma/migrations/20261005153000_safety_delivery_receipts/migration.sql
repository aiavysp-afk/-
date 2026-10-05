ALTER TABLE "OutboxEvent"
  ADD COLUMN "providerBizId" TEXT,
  ADD COLUMN "deliveryStatus" TEXT,
  ADD COLUMN "deliveryQueryAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "deliveryNextQueryAt" TIMESTAMP(3),
  ADD COLUMN "deliveryCheckedAt" TIMESTAMP(3),
  ADD COLUMN "deliveredAt" TIMESTAMP(3),
  ADD COLUMN "deliveryErrorCode" TEXT;

UPDATE "OutboxEvent"
SET
  "providerBizId" = split_part("providerReference", ':', 2),
  "deliveryStatus" = 'PENDING',
  "deliveryNextQueryAt" = CURRENT_TIMESTAMP
WHERE "type" IN ('SAFETY_INCIDENT_OPENED', 'SAFETY_INCIDENT_ESCALATED')
  AND "publishedAt" IS NOT NULL
  AND "providerReference" LIKE '%:%'
  AND split_part("providerReference", ':', 2) <> '';

ALTER TABLE "OutboxEvent"
  ADD CONSTRAINT "OutboxEvent_delivery_attempts_nonnegative"
  CHECK ("deliveryQueryAttempts" >= 0),
  ADD CONSTRAINT "OutboxEvent_delivery_status"
  CHECK ("deliveryStatus" IS NULL OR "deliveryStatus" IN ('PENDING', 'DELIVERED', 'FAILED', 'UNKNOWN')),
  ADD CONSTRAINT "OutboxEvent_delivery_provider_required"
  CHECK ("deliveryStatus" IS NULL OR ("publishedAt" IS NOT NULL AND "providerBizId" IS NOT NULL)),
  ADD CONSTRAINT "OutboxEvent_delivery_pending_schedule"
  CHECK (("deliveryStatus" = 'PENDING') = ("deliveryNextQueryAt" IS NOT NULL)),
  ADD CONSTRAINT "OutboxEvent_delivered_timestamp"
  CHECK (("deliveryStatus" = 'DELIVERED') = ("deliveredAt" IS NOT NULL));

CREATE INDEX "OutboxEvent_delivery_query_idx"
  ON "OutboxEvent"("deliveryStatus", "deliveryNextQueryAt", "leaseUntil");
