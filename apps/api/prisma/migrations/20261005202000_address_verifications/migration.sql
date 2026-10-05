CREATE TABLE "AddressVerification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "detailHash" TEXT NOT NULL,
    "adcode" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AddressVerification_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AddressVerification_adcode_check" CHECK ("adcode" ~ '^[0-9]{6}$'),
    CONSTRAINT "AddressVerification_detail_hash_check" CHECK ("detailHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "AddressVerification_expiry_check" CHECK ("expiresAt" > "createdAt")
);

CREATE UNIQUE INDEX "AddressVerification_reservationId_key" ON "AddressVerification"("reservationId");
CREATE INDEX "AddressVerification_userId_expiresAt_idx" ON "AddressVerification"("userId", "expiresAt");

ALTER TABLE "AddressVerification"
ADD CONSTRAINT "AddressVerification_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AddressVerification"
ADD CONSTRAINT "AddressVerification_reservationId_fkey"
FOREIGN KEY ("reservationId") REFERENCES "AppointmentReservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
