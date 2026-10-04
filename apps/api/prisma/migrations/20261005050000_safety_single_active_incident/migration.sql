CREATE UNIQUE INDEX "SafetyIncident_one_active_per_order"
ON "SafetyIncident"("orderId")
WHERE "status" <> 'CLOSED';
