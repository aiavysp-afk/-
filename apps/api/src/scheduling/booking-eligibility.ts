import { ConflictException } from "@nestjs/common";
import { Prisma, type AppointmentReservation } from "@prisma/client";

export const TECHNICIAN_UNAVAILABLE = "该技师暂不可预约，请重新选择预约时间";

// A recruitment application is not a bookable worker. Public booking requires
// an active tenant membership and the existing reviewed, published work profile.
export function bookableTechnicianWhere(
  organizationId: string,
  serviceId?: string,
): Prisma.UserWhereInput {
  return {
    status: "ACTIVE",
    memberships: {
      some: { organizationId, role: "THERAPIST", status: "ACTIVE" },
    },
    technicianProfile: {
      is: {
        organizationId,
        status: "PUBLISHED",
        ...(serviceId ? { serviceIds: { array_contains: [serviceId] } } : {}),
      },
    },
  };
}

type Booking = Pick<
  AppointmentReservation,
  "id" | "organizationId" | "therapistId" | "serviceId" | "startsAt" | "endsAt"
>;
type BookingReader = Pick<Prisma.TransactionClient, "appointmentReservation">;

export async function isReservationBookable(
  db: BookingReader,
  reservation: Booking | null,
): Promise<boolean> {
  if (!reservation) return false;
  const { id, organizationId, therapistId, serviceId, startsAt, endsAt } = reservation;
  const record = await db.appointmentReservation.findFirst({
    where: {
      id, organizationId, therapistId, serviceId,
      service: { organizationId, published: true },
      therapist: {
        ...bookableTechnicianWhere(organizationId, serviceId),
        therapistShifts: {
          some: {
            organizationId, status: "ACTIVE",
            startsAt: { lte: startsAt }, endsAt: { gte: endsAt },
          },
        },
      },
    },
    select: { id: true },
  });
  return !!record;
}

export async function assertReservationBookable(
  db: BookingReader,
  reservation: Booking | null,
): Promise<void> {
  if (!(await isReservationBookable(db, reservation)))
    throw new ConflictException(TECHNICIAN_UNAVAILABLE);
}
