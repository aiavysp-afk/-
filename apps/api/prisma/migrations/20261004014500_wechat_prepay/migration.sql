CREATE TYPE "WechatPrepayState" AS ENUM ('NONE', 'DISPATCHING', 'READY', 'UNKNOWN');
ALTER TABLE "Payment"
  ADD COLUMN "prepayState" "WechatPrepayState" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "prepayRequestedAt" TIMESTAMP(3),
  ADD COLUMN "prepayReadyAt" TIMESTAMP(3),
  ADD COLUMN "prepayFailureCode" TEXT;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_prepay_consistency" CHECK (
  ("prepayState" = 'NONE') OR
  ("provider" = 'WECHAT' AND "prepayRequestedAt" IS NOT NULL AND
   ("prepayState" <> 'READY' OR
    ("providerReference" IS NOT NULL AND "prepayReadyAt" IS NOT NULL)))
);
