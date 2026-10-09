CREATE TYPE "PaymentKind" AS ENUM ('SELF', 'FRIEND');
ALTER TABLE "Payment" ADD COLUMN "kind" "PaymentKind" NOT NULL DEFAULT 'SELF',
  ADD COLUMN "payerUserId" TEXT,
  ADD COLUMN "payerOpenIdHash" TEXT;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_payerUserId_fkey"
  FOREIGN KEY ("payerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Payment_payerUserId_createdAt_idx" ON "Payment"("payerUserId", "createdAt");
-- Legacy SELF records remain valid. New FRIEND payments must be durably bound to one real payer.
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_friend_payer_check" CHECK (
  "kind" <> 'FRIEND' OR ("provider" = 'WECHAT' AND "payerUserId" IS NOT NULL AND "payerOpenIdHash" IS NOT NULL)
);
CREATE TABLE "FriendPaymentShare" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FriendPaymentShare_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FriendPaymentShare_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "FriendPaymentShare_tokenHash_key" ON "FriendPaymentShare"("tokenHash");
CREATE INDEX "FriendPaymentShare_orderId_expiresAt_idx" ON "FriendPaymentShare"("orderId", "expiresAt");
