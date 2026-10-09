CREATE TYPE "StoredValueRechargeStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'UNKNOWN', 'CLOSED');

CREATE TABLE "StoredValueRecharge" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "amountFen" BIGINT NOT NULL,
  "status" "StoredValueRechargeStatus" NOT NULL DEFAULT 'PENDING',
  "merchantPaymentNo" TEXT NOT NULL,
  "providerReference" TEXT,
  "providerTransactionId" TEXT,
  "prepayState" "WechatPrepayState" NOT NULL DEFAULT 'NONE',
  "prepayRequestedAt" TIMESTAMP(3),
  "prepayReadyAt" TIMESTAMP(3),
  "prepayFailureCode" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "succeededAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StoredValueRecharge_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StoredValueRecharge_amountFen_check" CHECK ("amountFen" IN (59900, 88800, 119800, 288800))
);

ALTER TABLE "StoredValueTransaction" ADD COLUMN "rechargeId" TEXT;

CREATE UNIQUE INDEX "StoredValueRecharge_merchantPaymentNo_key" ON "StoredValueRecharge"("merchantPaymentNo");
CREATE UNIQUE INDEX "StoredValueRecharge_providerTransactionId_key" ON "StoredValueRecharge"("providerTransactionId");
CREATE UNIQUE INDEX "StoredValueRecharge_customerId_idempotencyKey_key" ON "StoredValueRecharge"("customerId", "idempotencyKey");
CREATE INDEX "StoredValueRecharge_organizationId_status_createdAt_idx" ON "StoredValueRecharge"("organizationId", "status", "createdAt");
CREATE INDEX "StoredValueRecharge_customerId_status_createdAt_idx" ON "StoredValueRecharge"("customerId", "status", "createdAt");
CREATE UNIQUE INDEX "StoredValueTransaction_rechargeId_key" ON "StoredValueTransaction"("rechargeId");

ALTER TABLE "StoredValueRecharge" ADD CONSTRAINT "StoredValueRecharge_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StoredValueRecharge" ADD CONSTRAINT "StoredValueRecharge_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StoredValueRecharge" ADD CONSTRAINT "StoredValueRecharge_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "StoredValueAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StoredValueTransaction" ADD CONSTRAINT "StoredValueTransaction_rechargeId_fkey" FOREIGN KEY ("rechargeId") REFERENCES "StoredValueRecharge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
