import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  MembershipStatus,
  OrderStatus,
  ReservationStatus,
  ShiftStatus,
  UserRole,
  type AppointmentReservation,
} from "@prisma/client";
import type {
  AvailabilityQuery,
  AvailabilitySlot,
  BookingHold,
  BookingHoldCreate,
  ShiftCreate,
} from "@zydj/contracts";
import { AccessControlService } from "../auth/access-control.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { PrismaService } from "../database/prisma.service.js";

const SLOT_INTERVAL_MS = 30 * 60 * 1_000;
const HOLD_TTL_MS = 10 * 60 * 1_000;
const MIN_BOOKING_NOTICE_MS = 15 * 60 * 1_000;
const MAX_BOOKING_HORIZON_MS = 90 * 24 * 60 * 60 * 1_000;

@Injectable()
export class SchedulingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
  ) {}

  async listAvailability(
    query: AvailabilityQuery,
  ): Promise<AvailabilitySlot[]> {
    const { start, end } = this.shanghaiDayBounds(query.date);
    const service = await this.prisma.service.findFirst({
      where: { id: query.serviceId, published: true },
    });
    if (!service) throw new NotFoundException("服务不存在或未上架");

    const now = new Date();
    const shifts = await this.prisma.therapistShift.findMany({
      where: {
        organizationId: service.organizationId,
        status: ShiftStatus.ACTIVE,
        startsAt: { lt: end },
        endsAt: { gt: start },
      },
      orderBy: [{ startsAt: "asc" }, { therapistId: "asc" }],
    });
    if (!shifts.length) return [];

    const reservations = await this.prisma.appointmentReservation.findMany({
      where: {
        therapistId: {
          in: [...new Set(shifts.map((shift) => shift.therapistId))],
        },
        startsAt: { lt: end },
        endsAt: { gt: start },
        OR: [
          { status: ReservationStatus.CONFIRMED },
          { status: ReservationStatus.HOLD, expiresAt: { gt: now } },
        ],
      },
    });

    const durationMs = service.durationMinutes * 60 * 1_000;
    const slots: AvailabilitySlot[] = [];
    for (const shift of shifts) {
      const firstCandidate = this.ceilToInterval(
        Math.max(
          shift.startsAt.getTime(),
          start.getTime(),
          now.getTime() + MIN_BOOKING_NOTICE_MS,
        ),
      );
      const shiftEnd = Math.min(shift.endsAt.getTime(), end.getTime());
      for (
        let startsAtMs = firstCandidate;
        startsAtMs + durationMs <= shiftEnd;
        startsAtMs += SLOT_INTERVAL_MS
      ) {
        const endsAtMs = startsAtMs + durationMs;
        const occupied = reservations.some(
          (reservation) =>
            reservation.therapistId === shift.therapistId &&
            reservation.startsAt.getTime() < endsAtMs &&
            reservation.endsAt.getTime() > startsAtMs,
        );
        if (!occupied) {
          slots.push({
            therapistId: shift.therapistId,
            startsAt: new Date(startsAtMs).toISOString(),
            endsAt: new Date(endsAtMs).toISOString(),
          });
        }
      }
    }
    return slots;
  }

  async createShift(principal: AuthPrincipal, input: ShiftCreate) {
    this.access.assertPermission(
      principal,
      "schedule.write",
      input.organizationId,
    );
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    if (startsAt.getTime() < Date.now()) {
      throw new BadRequestException("不能创建已经开始的排班");
    }

    const membership = await this.prisma.staffMembership.findFirst({
      where: {
        userId: input.therapistId,
        organizationId: input.organizationId,
        role: UserRole.THERAPIST,
        status: MembershipStatus.ACTIVE,
      },
    });
    if (!membership)
      throw new BadRequestException("技师不属于当前组织或账号不可用");

    try {
      const shift = await this.prisma.$transaction(async (tx) => {
        const record = await tx.therapistShift.create({
          data: {
            organizationId: input.organizationId,
            therapistId: input.therapistId,
            startsAt,
            endsAt,
            createdById: principal.userId,
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: principal.userId,
            organizationId: input.organizationId,
            action: "THERAPIST_SHIFT_CREATED",
            resourceType: "TherapistShift",
            resourceId: record.id,
            metadata: { therapistId: input.therapistId, startsAt, endsAt },
          },
        });
        return record;
      });
      return this.toShift(shift);
    } catch (error) {
      if (this.isExclusionViolation(error, "TherapistShift_no_overlap")) {
        throw new ConflictException("该技师已有重叠排班");
      }
      throw error;
    }
  }

  async listShifts(
    principal: AuthPrincipal,
    organizationId: string,
    date: string,
  ) {
    this.access.assertPermission(principal, "schedule.read", organizationId);
    const { start, end } = this.shanghaiDayBounds(date);
    const shifts = await this.prisma.therapistShift.findMany({
      where: {
        organizationId,
        startsAt: { lt: end },
        endsAt: { gt: start },
      },
      include: { therapist: { select: { displayName: true } } },
      orderBy: [{ startsAt: "asc" }, { therapistId: "asc" }],
    });
    return shifts.map((shift) => ({
      ...this.toShift(shift),
      therapistDisplayName: shift.therapist.displayName,
    }));
  }

  async createHold(
    principal: AuthPrincipal,
    input: BookingHoldCreate,
  ): Promise<BookingHold> {
    const startsAt = new Date(input.startsAt);
    const now = new Date();
    if (
      startsAt.getUTCSeconds() !== 0 ||
      startsAt.getUTCMilliseconds() !== 0 ||
      startsAt.getTime() % SLOT_INTERVAL_MS !== 0
    ) {
      throw new BadRequestException("预约开始时间必须按 30 分钟对齐");
    }
    if (startsAt.getTime() < now.getTime() + MIN_BOOKING_NOTICE_MS) {
      throw new BadRequestException("预约至少需要提前 15 分钟");
    }
    if (startsAt.getTime() > now.getTime() + MAX_BOOKING_HORIZON_MS) {
      throw new BadRequestException("最多可预约未来 90 天");
    }

    const service = await this.prisma.service.findFirst({
      where: { id: input.serviceId, published: true },
    });
    if (!service) throw new NotFoundException("服务不存在或未上架");
    const endsAt = new Date(
      startsAt.getTime() + service.durationMinutes * 60 * 1_000,
    );

    const therapist = await this.prisma.staffMembership.findFirst({
      where: {
        userId: input.therapistId,
        organizationId: service.organizationId,
        role: UserRole.THERAPIST,
        status: MembershipStatus.ACTIVE,
      },
    });
    if (!therapist) throw new BadRequestException("所选技师当前不可预约");

    const shift = await this.prisma.therapistShift.findFirst({
      where: {
        organizationId: service.organizationId,
        therapistId: input.therapistId,
        status: ShiftStatus.ACTIVE,
        startsAt: { lte: startsAt },
        endsAt: { gte: endsAt },
      },
    });
    if (!shift) throw new BadRequestException("所选时间不在技师排班内");

    const expiresAt = new Date(now.getTime() + HOLD_TTL_MS);
    try {
      const hold = await this.prisma.$transaction(async (tx) => {
        const expired = await tx.appointmentReservation.findMany({
          where: {
            status: ReservationStatus.HOLD,
            expiresAt: { lte: now },
            OR: [
              { therapistId: input.therapistId },
              { customerId: principal.userId },
            ],
          },
          select: { id: true },
        });
        const expiredIds = expired.map((item) => item.id);
        await tx.appointmentReservation.updateMany({
          where: {
            id: { in: expiredIds },
            status: ReservationStatus.HOLD,
          },
          data: { status: ReservationStatus.EXPIRED },
        });
        if (expiredIds.length) {
          const expiredOrders = await tx.order.findMany({
            where: {
              reservationId: { in: expiredIds },
              status: OrderStatus.PENDING_PAYMENT,
            },
            select: { id: true },
          });
          const expiredOrderIds = expiredOrders.map((order) => order.id);
          await tx.order.updateMany({
            where: {
              id: { in: expiredOrderIds },
              status: OrderStatus.PENDING_PAYMENT,
            },
            data: { status: OrderStatus.CANCELLED },
          });
          if (expiredOrderIds.length) {
            await tx.orderEvent.createMany({
              data: expiredOrderIds.map((orderId) => ({
                orderId,
                type: "PAYMENT_EXPIRED",
                payload: {},
              })),
            });
          }
        }
        const record = await tx.appointmentReservation.create({
          data: {
            organizationId: service.organizationId,
            serviceId: service.id,
            serviceAmountFen: service.priceFen,
            therapistId: input.therapistId,
            customerId: principal.userId,
            startsAt,
            endsAt,
            expiresAt,
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: principal.userId,
            organizationId: service.organizationId,
            action: "APPOINTMENT_HOLD_CREATED",
            resourceType: "AppointmentReservation",
            resourceId: record.id,
            metadata: { serviceId: service.id, therapistId: input.therapistId },
          },
        });
        return record;
      });
      return this.toHold(hold);
    } catch (error) {
      if (
        this.isExclusionViolation(error, "AppointmentReservation_no_overlap")
      ) {
        throw new ConflictException("该预约时段刚刚被占用，请选择其他时间");
      }
      if (
        this.isUniqueViolation(
          error,
          "AppointmentReservation_one_hold_per_customer",
        )
      ) {
        throw new ConflictException("当前账号已有进行中的预约占位");
      }
      throw error;
    }
  }

  async releaseHold(principal: AuthPrincipal, id: string) {
    const hold = await this.prisma.appointmentReservation.findUnique({
      where: { id },
      include: { order: { select: { id: true } } },
    });
    if (!hold) throw new NotFoundException("预约占位不存在");
    if (hold.customerId !== principal.userId) {
      throw new ForbiddenException("不能释放其他用户的预约占位");
    }
    if (hold.order) {
      throw new ConflictException("预约占位已生成订单，请取消订单");
    }
    if (hold.status !== ReservationStatus.HOLD) {
      throw new ConflictException("预约占位已经结束");
    }
    const released = await this.prisma.$transaction(async (tx) => {
      const result = await tx.appointmentReservation.updateMany({
        where: {
          id,
          customerId: principal.userId,
          status: ReservationStatus.HOLD,
        },
        data: { status: ReservationStatus.RELEASED },
      });
      if (result.count !== 1) throw new ConflictException("预约占位状态已变化");
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId: hold.organizationId,
          action: "APPOINTMENT_HOLD_RELEASED",
          resourceType: "AppointmentReservation",
          resourceId: id,
          metadata: {},
        },
      });
      return true;
    });
    return { released };
  }

  private shanghaiDayBounds(date: string) {
    const [year, month, day] = date.split("-").map(Number);
    const normalized = new Date(Date.UTC(year!, month! - 1, day));
    if (
      normalized.getUTCFullYear() !== year ||
      normalized.getUTCMonth() !== month! - 1 ||
      normalized.getUTCDate() !== day
    ) {
      throw new BadRequestException("日期无效");
    }
    const start = new Date(`${date}T00:00:00+08:00`);
    if (Number.isNaN(start.getTime()))
      throw new BadRequestException("日期无效");
    return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1_000) };
  }

  private ceilToInterval(value: number) {
    return Math.ceil(value / SLOT_INTERVAL_MS) * SLOT_INTERVAL_MS;
  }

  private isExclusionViolation(error: unknown, constraint: string) {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes(constraint) || message.includes("23P01");
  }

  private isUniqueViolation(error: unknown, constraint: string) {
    const candidate = error as { code?: string; message?: string };
    return (
      candidate.code === "P2002" ||
      candidate.message?.includes(constraint) === true
    );
  }

  private toShift(shift: {
    id: string;
    organizationId: string;
    therapistId: string;
    startsAt: Date;
    endsAt: Date;
    status: ShiftStatus;
  }) {
    return {
      id: shift.id,
      organizationId: shift.organizationId,
      therapistId: shift.therapistId,
      startsAt: shift.startsAt.toISOString(),
      endsAt: shift.endsAt.toISOString(),
      status: shift.status,
    };
  }

  private toHold(hold: AppointmentReservation): BookingHold {
    return {
      id: hold.id,
      serviceId: hold.serviceId,
      therapistId: hold.therapistId,
      startsAt: hold.startsAt.toISOString(),
      endsAt: hold.endsAt.toISOString(),
      expiresAt: hold.expiresAt.toISOString(),
      status: "HOLD",
    };
  }
}
