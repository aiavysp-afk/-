CREATE TABLE "TechnicianIntakeApplication" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "nameEncrypted" TEXT NOT NULL,
    "phoneEncrypted" TEXT NOT NULL,
    "phoneHash" TEXT NOT NULL,
    "certificateEncrypted" TEXT NOT NULL,
    "certificateDigest" TEXT NOT NULL,
    "submissionKeyHash" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "consentVersion" TEXT NOT NULL,
    "consentAcceptedAt" TIMESTAMP(3) NOT NULL,
    "status" "TechnicianProfileStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "version" INTEGER NOT NULL DEFAULT 1,
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TechnicianIntakeApplication_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TechnicianIntakeApplication_review_status" CHECK ("status" IN ('PENDING_REVIEW', 'APPROVED', 'REJECTED')),
    CONSTRAINT "TechnicianIntakeApplication_version_positive" CHECK ("version" > 0)
);
CREATE UNIQUE INDEX "TechnicianIntakeApplication_submissionKeyHash_key" ON "TechnicianIntakeApplication"("submissionKeyHash");
CREATE INDEX "TechnicianIntakeApplication_organizationId_status_id_idx" ON "TechnicianIntakeApplication"("organizationId", "status", "id");
CREATE INDEX "TechnicianIntakeApplication_phoneHash_createdAt_idx" ON "TechnicianIntakeApplication"("phoneHash", "createdAt");
ALTER TABLE "TechnicianIntakeApplication" ADD CONSTRAINT "TechnicianIntakeApplication_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
