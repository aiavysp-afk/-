ALTER TABLE "CustomerCoupon" ADD COLUMN "sourceCode" TEXT;
ALTER TABLE "CustomerCoupon" ADD COLUMN "usedOrderId" TEXT;
CREATE UNIQUE INDEX "CustomerCoupon_organizationId_customerId_sourceCode_key" ON "CustomerCoupon"("organizationId", "customerId", "sourceCode");
CREATE UNIQUE INDEX "CustomerCoupon_usedOrderId_key" ON "CustomerCoupon"("usedOrderId");
ALTER TABLE "CustomerCoupon" ADD CONSTRAINT "CustomerCoupon_usedOrderId_fkey" FOREIGN KEY ("usedOrderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
