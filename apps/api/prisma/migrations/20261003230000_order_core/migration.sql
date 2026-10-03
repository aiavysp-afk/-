ALTER TABLE "AppointmentReservation" ADD COLUMN "serviceAmountFen" BIGINT;

UPDATE "AppointmentReservation" AS reservation
SET "serviceAmountFen" = service."priceFen"
FROM "Service" AS service
WHERE reservation."serviceId" = service."id";

ALTER TABLE "AppointmentReservation" ALTER COLUMN "serviceAmountFen" SET NOT NULL;
ALTER TABLE "AppointmentReservation" ADD CONSTRAINT "AppointmentReservation_service_amount_check" CHECK ("serviceAmountFen" >= 0);

ALTER TABLE "Order" ADD COLUMN "reservationId" TEXT;
ALTER TABLE "Order" ADD COLUMN "paymentExpiresAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD CONSTRAINT "Order_payment_expiry_check" CHECK ("paymentExpiresAt" IS NULL OR "paymentExpiresAt" > "createdAt");

CREATE UNIQUE INDEX "Order_reservationId_key" ON "Order"("reservationId");
ALTER TABLE "Order" ADD CONSTRAINT "Order_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "AppointmentReservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
