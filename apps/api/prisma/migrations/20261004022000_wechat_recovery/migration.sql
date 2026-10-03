CREATE TYPE "WechatCloseState" AS ENUM ('NONE', 'DISPATCHING', 'UNKNOWN', 'CONFIRMED');
ALTER TABLE "Payment"
  ADD COLUMN "closeState" "WechatCloseState" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "closeRequestedAt" TIMESTAMP(3),
  ADD COLUMN "closeReason" TEXT,
  ADD COLUMN "closeDispatchedAt" TIMESTAMP(3),
  ADD COLUMN "closeVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "closeAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "providerTradeState" TEXT,
  ADD COLUMN "providerCheckedAt" TIMESTAMP(3),
  ADD COLUMN "recoveryAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "recoveryNextCheckAt" TIMESTAMP(3),
  ADD COLUMN "recoveryLeaseToken" TEXT,
  ADD COLUMN "recoveryLeaseUntil" TIMESTAMP(3),
  ADD COLUMN "recoveryFailureCode" TEXT,
  ADD COLUMN "recoveryReviewAt" TIMESTAMP(3),
  ADD CONSTRAINT "Payment_recovery_counts_check" CHECK (
    "recoveryAttempts" BETWEEN 0 AND 12 AND "closeAttempts" BETWEEN 0 AND "recoveryAttempts"
  ),
  ADD CONSTRAINT "Payment_recovery_lease_check" CHECK (
    ("recoveryLeaseToken" IS NULL) = ("recoveryLeaseUntil" IS NULL)
  ),
  ADD CONSTRAINT "Payment_close_intent_check" CHECK (
    ("closeRequestedAt" IS NULL AND "closeReason" IS NULL) OR
    ("provider" = 'WECHAT' AND "closeRequestedAt" IS NOT NULL AND "closeReason" IS NOT NULL AND
      "closeReason" IN ('CUSTOMER', 'EXPIRED', 'PROVIDER_CLOSED'))
  ),
  ADD CONSTRAINT "Payment_close_state_check" CHECK (
    "closeState" = 'NONE' OR ("provider" = 'WECHAT' AND "closeRequestedAt" IS NOT NULL AND
      (("closeState" IN ('DISPATCHING', 'UNKNOWN') AND "closeDispatchedAt" IS NOT NULL AND "closeAttempts" > 0) OR
       ("closeState" = 'CONFIRMED' AND "closeVerifiedAt" IS NOT NULL AND "closedAt" IS NOT NULL)))
  );
CREATE INDEX "Payment_provider_status_recoveryNextCheckAt_idx" ON "Payment"("provider", "status", "recoveryNextCheckAt");
