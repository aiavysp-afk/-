ALTER TABLE "StoredValueRecharge" DROP CONSTRAINT "StoredValueRecharge_amountFen_check";
ALTER TABLE "StoredValueRecharge" ADD CONSTRAINT "StoredValueRecharge_amountFen_check" CHECK ("amountFen" IN (28800, 59900, 88800, 119800, 288800));

CREATE TABLE "StoredValueFirstRechargeReward" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "rechargeId" TEXT NOT NULL,
    "amountFen" BIGINT NOT NULL DEFAULT 8800,
    "claimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StoredValueFirstRechargeReward_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StoredValueFirstRechargeReward_amount_check" CHECK ("amountFen" = 8800)
);
CREATE UNIQUE INDEX "StoredValueFirstRechargeReward_accountId_key" ON "StoredValueFirstRechargeReward"("accountId");
CREATE UNIQUE INDEX "StoredValueFirstRechargeReward_rechargeId_key" ON "StoredValueFirstRechargeReward"("rechargeId");
ALTER TABLE "StoredValueFirstRechargeReward" ADD CONSTRAINT "StoredValueFirstRechargeReward_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "StoredValueAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StoredValueFirstRechargeReward" ADD CONSTRAINT "StoredValueFirstRechargeReward_rechargeId_fkey" FOREIGN KEY ("rechargeId") REFERENCES "StoredValueRecharge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StoredValueTransaction" ADD COLUMN "rewardId" TEXT;
CREATE UNIQUE INDEX "StoredValueTransaction_rewardId_key" ON "StoredValueTransaction"("rewardId");
ALTER TABLE "StoredValueTransaction" ADD CONSTRAINT "StoredValueTransaction_rewardId_fkey" FOREIGN KEY ("rewardId") REFERENCES "StoredValueFirstRechargeReward"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
