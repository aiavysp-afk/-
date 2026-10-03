CREATE TYPE "RefundStatus" AS ENUM ('REQUESTED', 'APPROVED', 'PROCESSING', 'UNKNOWN', 'ABNORMAL', 'CLOSED', 'SUCCEEDED', 'REJECTED');
CREATE TYPE "RefundReason" AS ENUM ('CUSTOMER_CANCELLED', 'UNFULFILLABLE', 'LATE_PAYMENT');

ALTER TABLE "Payment" ADD COLUMN "refundReservedFen" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "Payment" ADD COLUMN "refundedFen" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_refund_budget_check" CHECK (
  "refundReservedFen" >= 0 AND "refundedFen" >= 0 AND "refundReservedFen" + "refundedFen" <= "amountFen"
);

CREATE TABLE "Refund" (
  "id" TEXT PRIMARY KEY,
  "paymentId" TEXT NOT NULL REFERENCES "Payment"("id"),
  "merchantRefundNo" TEXT NOT NULL UNIQUE,
  "amountFen" BIGINT NOT NULL CHECK ("amountFen" > 0),
  "status" "RefundStatus" NOT NULL DEFAULT 'REQUESTED',
  "reason" "RefundReason" NOT NULL,
  "policyVersion" TEXT NOT NULL,
  "requestedById" TEXT NOT NULL,
  "reviewedById" TEXT,
  "reviewCode" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "providerRefundId" TEXT UNIQUE,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" TIMESTAMP(3),
  "submittedAt" TIMESTAMP(3),
  "succeededAt" TIMESTAMP(3),
  "nextCheckAt" TIMESTAMP(3),
  "checkAttempts" INTEGER NOT NULL DEFAULT 0 CHECK ("checkAttempts" >= 0),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  UNIQUE ("paymentId", "idempotencyKey"),
  CONSTRAINT "Refund_reviewer_separation" CHECK ("reviewedById" IS NULL OR "reviewedById" <> "requestedById"),
  CONSTRAINT "Refund_success_time_check" CHECK ("status" <> 'SUCCEEDED' OR "succeededAt" IS NOT NULL)
);
CREATE INDEX "Refund_paymentId_status_idx" ON "Refund"("paymentId", "status");
CREATE INDEX "Refund_status_nextCheckAt_idx" ON "Refund"("status", "nextCheckAt");

CREATE TABLE "RefundEvent" (
  "id" TEXT PRIMARY KEY,
  "refundId" TEXT NOT NULL REFERENCES "Refund"("id"),
  "type" TEXT NOT NULL,
  "actorId" TEXT,
  "providerEventId" TEXT UNIQUE,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "RefundEvent_refundId_createdAt_idx" ON "RefundEvent"("refundId", "createdAt");

CREATE TABLE "RefundLedgerPosting" (
  "id" TEXT PRIMARY KEY,
  "refundId" TEXT NOT NULL UNIQUE REFERENCES "Refund"("id"),
  "amountFen" BIGINT NOT NULL CHECK ("amountFen" > 0),
  "debitAccount" TEXT NOT NULL DEFAULT 'CUSTOMER_REFUND_LIABILITY',
  "creditAccount" TEXT NOT NULL DEFAULT 'CHANNEL_REFUND_OUTFLOW',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RefundLedgerPosting_accounts_check" CHECK (
    "debitAccount" = 'CUSTOMER_REFUND_LIABILITY' AND "creditAccount" = 'CHANNEL_REFUND_OUTFLOW'
  )
);
