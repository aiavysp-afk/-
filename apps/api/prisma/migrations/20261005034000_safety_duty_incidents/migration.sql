CREATE TYPE "SafetyIncidentStatus" AS ENUM ('OPEN', 'ESCALATED', 'ACKNOWLEDGED', 'CLOSED');
CREATE TYPE "SafetyIncidentCategory" AS ENUM ('PERSONAL_SAFETY', 'MEDICAL_CONCERN', 'SERVICE_DISPUTE', 'OTHER_URGENT');

CREATE TABLE "SafetyDutyRoster" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "primaryUserId" TEXT NOT NULL,
    "backupUserId" TEXT NOT NULL,
    "acknowledgementTimeoutSeconds" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deactivatedAt" TIMESTAMP(3),
    CONSTRAINT "SafetyDutyRoster_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SafetyDutyRoster_distinct_staff" CHECK ("primaryUserId" <> "backupUserId"),
    CONSTRAINT "SafetyDutyRoster_timeout_range" CHECK ("acknowledgementTimeoutSeconds" BETWEEN 60 AND 900)
);

CREATE TABLE "SafetyIncident" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "reporterUserId" TEXT NOT NULL,
    "rosterId" TEXT NOT NULL,
    "primaryUserId" TEXT NOT NULL,
    "backupUserId" TEXT NOT NULL,
    "category" "SafetyIncidentCategory" NOT NULL,
    "status" "SafetyIncidentStatus" NOT NULL DEFAULT 'OPEN',
    "idempotencyKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "acknowledgementDueAt" TIMESTAMP(3) NOT NULL,
    "acknowledgedById" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "escalatedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "resolutionCode" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SafetyIncident_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SafetyIncident_distinct_staff" CHECK ("primaryUserId" <> "backupUserId"),
    CONSTRAINT "SafetyIncident_idempotency_length" CHECK (char_length("idempotencyKey") BETWEEN 16 AND 128),
    CONSTRAINT "SafetyIncident_fingerprint_format" CHECK ("requestFingerprint" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "SafetyIncident_due_after_create" CHECK ("acknowledgementDueAt" >= "createdAt"),
    CONSTRAINT "SafetyIncident_state_consistency" CHECK (
        (
            "status" = 'OPEN'
            AND "acknowledgedById" IS NULL AND "acknowledgedAt" IS NULL
            AND "escalatedAt" IS NULL
            AND "closedById" IS NULL AND "resolutionCode" IS NULL AND "closedAt" IS NULL
        ) OR (
            "status" = 'ESCALATED'
            AND "acknowledgedById" IS NULL AND "acknowledgedAt" IS NULL
            AND "escalatedAt" IS NOT NULL
            AND "closedById" IS NULL AND "resolutionCode" IS NULL AND "closedAt" IS NULL
        ) OR (
            "status" = 'ACKNOWLEDGED'
            AND "acknowledgedById" IS NOT NULL AND "acknowledgedAt" IS NOT NULL
            AND "closedById" IS NULL AND "resolutionCode" IS NULL AND "closedAt" IS NULL
            AND (
                ("escalatedAt" IS NULL AND "acknowledgedById" = "primaryUserId")
                OR ("escalatedAt" IS NOT NULL AND "acknowledgedById" = "backupUserId")
            )
        ) OR (
            "status" = 'CLOSED'
            AND "acknowledgedById" IS NOT NULL AND "acknowledgedAt" IS NOT NULL
            AND "closedById" = "acknowledgedById" AND "closedAt" IS NOT NULL
            AND "resolutionCode" IN ('RESOLVED', 'REFERRED_PUBLIC_EMERGENCY', 'FALSE_ALARM', 'FOLLOW_UP_REQUIRED')
            AND (
                ("escalatedAt" IS NULL AND "acknowledgedById" = "primaryUserId")
                OR ("escalatedAt" IS NOT NULL AND "acknowledgedById" = "backupUserId")
            )
        )
    )
);

CREATE TABLE "SafetyIncidentEvent" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actorId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SafetyIncidentEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SafetyDutyRoster_one_active_per_org"
ON "SafetyDutyRoster"("organizationId") WHERE "active" = true;
CREATE INDEX "SafetyDutyRoster_organizationId_active_idx" ON "SafetyDutyRoster"("organizationId", "active");
CREATE INDEX "SafetyDutyRoster_primaryUserId_active_idx" ON "SafetyDutyRoster"("primaryUserId", "active");
CREATE INDEX "SafetyDutyRoster_backupUserId_active_idx" ON "SafetyDutyRoster"("backupUserId", "active");

CREATE UNIQUE INDEX "SafetyIncident_reporterUserId_idempotencyKey_key" ON "SafetyIncident"("reporterUserId", "idempotencyKey");
CREATE INDEX "SafetyIncident_organizationId_status_createdAt_idx" ON "SafetyIncident"("organizationId", "status", "createdAt");
CREATE INDEX "SafetyIncident_status_acknowledgementDueAt_idx" ON "SafetyIncident"("status", "acknowledgementDueAt");
CREATE INDEX "SafetyIncident_orderId_createdAt_idx" ON "SafetyIncident"("orderId", "createdAt");
CREATE INDEX "SafetyIncidentEvent_incidentId_createdAt_idx" ON "SafetyIncidentEvent"("incidentId", "createdAt");

ALTER TABLE "SafetyDutyRoster" ADD CONSTRAINT "SafetyDutyRoster_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SafetyDutyRoster" ADD CONSTRAINT "SafetyDutyRoster_primaryUserId_fkey" FOREIGN KEY ("primaryUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SafetyDutyRoster" ADD CONSTRAINT "SafetyDutyRoster_backupUserId_fkey" FOREIGN KEY ("backupUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SafetyDutyRoster" ADD CONSTRAINT "SafetyDutyRoster_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SafetyIncident" ADD CONSTRAINT "SafetyIncident_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SafetyIncident" ADD CONSTRAINT "SafetyIncident_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SafetyIncident" ADD CONSTRAINT "SafetyIncident_reporterUserId_fkey" FOREIGN KEY ("reporterUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SafetyIncident" ADD CONSTRAINT "SafetyIncident_rosterId_fkey" FOREIGN KEY ("rosterId") REFERENCES "SafetyDutyRoster"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SafetyIncident" ADD CONSTRAINT "SafetyIncident_primaryUserId_fkey" FOREIGN KEY ("primaryUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SafetyIncident" ADD CONSTRAINT "SafetyIncident_backupUserId_fkey" FOREIGN KEY ("backupUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SafetyIncident" ADD CONSTRAINT "SafetyIncident_acknowledgedById_fkey" FOREIGN KEY ("acknowledgedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SafetyIncident" ADD CONSTRAINT "SafetyIncident_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SafetyIncidentEvent" ADD CONSTRAINT "SafetyIncidentEvent_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "SafetyIncident"("id") ON DELETE CASCADE ON UPDATE CASCADE;
