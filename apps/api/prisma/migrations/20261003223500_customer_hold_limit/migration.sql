CREATE UNIQUE INDEX "AppointmentReservation_one_hold_per_customer"
  ON "AppointmentReservation"("customerId")
  WHERE ("status" = 'HOLD');
