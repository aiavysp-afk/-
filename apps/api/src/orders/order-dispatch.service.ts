import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import {
  MembershipStatus,
  OrderStatus,
  ReservationStatus,
  ShiftStatus,
  UserRole,
} from "@prisma/client";
import type {
  DispatchAssignment,
  DispatchAssignmentResult,
  DispatchBoard,
} from "@zydj/contracts";
import { AccessControlService } from "../auth/access-control.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { PrismaService } from "../database/prisma.service.js";
import { OrderStateMachine } from "./order-state-machine.js";

const BOARD_STATUSES: OrderStatus[] = [
  OrderStatus.PAID,
  OrderStatus.DISPATCHING,
  OrderStatus.ASSIGNED,
];

@Injectable()
export class OrderDispatchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly stateMachine: OrderStateMachine,
  ) {}

  async getBoard(
    principal: AuthPrincipal,
    organizationId: string,
    now = new Date(),
  ): Promise<DispatchBoard> {
    this.access.assertPermission(principal, "orders.dispatch", organizationId);
    const orders = await this.prisma.order.findMany({
      where: {
        organizationId,
        status: { in: BOARD_STATUSES },
        appointmentEnd: { gt: now },
      },
      include: {
        customer: { select: { displayName: true } },
        therapist: { select: { id: true, displayName: true } },
        items: {
          select: { serviceName: true, durationMinutes: true },
          take: 1,
        },
      },
      orderBy: [{ appointmentStart: "asc" }, { createdAt: "asc" }],
      take: 100,
    });

    const memberships = await this.prisma.staffMembership.findMany({
      where: {
        organizationId,
        role: UserRole.THERAPIST,
        status: MembershipStatus.ACTIVE,
        user: { status: "ACTIVE" },
      },
      include: { user: { select: { id: true, displayName: true } } },
      orderBy: { createdAt: "asc" },
    });
    const therapistIds = memberships.map((membership) => membership.userId);
    const shifts = therapistIds.length
      ? await this.prisma.therapistShift.findMany({
          where: {
            organizationId,
            therapistId: { in: therapistIds },
            status: ShiftStatus.ACTIVE,
          },
          select: { therapistId: true, startsAt: true, endsAt: true },
        })
      : [];
    const reservations =
      orders.length && therapistIds.length
        ? await this.prisma.appointmentReservation.findMany({
            where: {
              organizationId,
              therapistId: { in: therapistIds },
              startsAt: {
                lt: new Date(
                  Math.max(
                    ...orders.map((order) => order.appointmentEnd.getTime()),
                  ),
                ),
              },
              endsAt: {
                gt: new Date(
                  Math.min(
                    ...orders.map((order) => order.appointmentStart.getTime()),
                  ),
                ),
              },
              OR: [
                { status: ReservationStatus.CONFIRMED },
                { status: ReservationStatus.HOLD, expiresAt: { gt: now } },
              ],
            },
            select: {
              id: true,
              therapistId: true,
              startsAt: true,
              endsAt: true,
            },
          })
        : [];

    return {
      generatedAt: now.toISOString(),
      timeZone: "Asia/Shanghai",
      orders: orders.map((order) => {
        const item = order.items[0];
        if (!item) {
          throw new InternalServerErrorException("订单服务快照不完整");
        }
        const eligibleTherapists = memberships
          .filter(
            (membership) =>
              shifts.some(
                (shift) =>
                  shift.therapistId === membership.userId &&
                  shift.startsAt <= order.appointmentStart &&
                  shift.endsAt >= order.appointmentEnd,
              ) &&
              !reservations.some(
                (reservation) =>
                  reservation.therapistId === membership.userId &&
                  reservation.id !== order.reservationId &&
                  reservation.startsAt < order.appointmentEnd &&
                  reservation.endsAt > order.appointmentStart,
              ),
          )
          .map((membership) => membership.user);
        return {
          id: order.id,
          orderNo: order.orderNo,
          customerName: order.customer.displayName,
          serviceName: item.serviceName,
          durationMinutes: item.durationMinutes,
          appointmentStart: order.appointmentStart.toISOString(),
          appointmentEnd: order.appointmentEnd.toISOString(),
          status: order.status,
          payableFen: this.safeMoney(order.payableFen),
          therapist: order.therapist,
          eligibleTherapists,
        };
      }),
    };
  }

  async assign(
    principal: AuthPrincipal,
    organizationId: string,
    orderId: string,
    input: DispatchAssignment,
    now = new Date(),
  ): Promise<DispatchAssignmentResult> {
    this.access.assertPermission(principal, "orders.dispatch", organizationId);

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
        const order = await tx.order.findUnique({
          where: { id: orderId },
          select: {
            id: true,
            organizationId: true,
            status: true,
            therapistId: true,
            reservationId: true,
            appointmentStart: true,
            appointmentEnd: true,
          },
        });
        if (!order || order.organizationId !== organizationId) {
          throw new NotFoundException("待调度订单不存在");
        }

        const therapistMembership = await tx.staffMembership.findFirst({
          where: {
            userId: input.therapistId,
            organizationId,
            role: UserRole.THERAPIST,
            status: MembershipStatus.ACTIVE,
          },
          include: { user: { select: { id: true, displayName: true } } },
        });
        if (!therapistMembership) {
          throw new BadRequestException("技师不属于当前组织或账号不可用");
        }

        if (order.status === OrderStatus.ASSIGNED) {
          if (order.therapistId !== input.therapistId) {
            throw new ConflictException("订单已指派，改派需走单独复核流程");
          }
          return {
            orderId: order.id,
            status: "ASSIGNED" as const,
            therapist: therapistMembership.user,
          };
        }
        if (
          order.status !== OrderStatus.PAID &&
          order.status !== OrderStatus.DISPATCHING
        ) {
          throw new ConflictException("当前订单状态不可指派技师");
        }
        if (order.appointmentEnd <= now) {
          throw new ConflictException("预约时间已结束，不能继续指派");
        }

        const shift = await tx.therapistShift.findFirst({
          where: {
            organizationId,
            therapistId: input.therapistId,
            status: ShiftStatus.ACTIVE,
            startsAt: { lte: order.appointmentStart },
            endsAt: { gte: order.appointmentEnd },
          },
        });
        if (!shift) throw new ConflictException("预约时段不在该技师排班内");

        const conflict = await tx.appointmentReservation.findFirst({
          where: {
            organizationId,
            therapistId: input.therapistId,
            ...(order.reservationId
              ? { id: { not: order.reservationId } }
              : {}),
            startsAt: { lt: order.appointmentEnd },
            endsAt: { gt: order.appointmentStart },
            OR: [
              { status: ReservationStatus.CONFIRMED },
              { status: ReservationStatus.HOLD, expiresAt: { gt: now } },
            ],
          },
          select: { id: true },
        });
        if (conflict) throw new ConflictException("该技师预约时段已被占用");

        let currentStatus: OrderStatus = order.status;
        if (currentStatus === OrderStatus.PAID) {
          const next = this.stateMachine.transition(
            currentStatus,
            "DISPATCH_STARTED",
          );
          const started = await tx.order.updateMany({
            where: { id: order.id, status: currentStatus },
            data: { status: next },
          });
          if (started.count !== 1)
            throw new ConflictException("订单调度状态已变化");
          await tx.orderEvent.create({
            data: {
              orderId: order.id,
              type: "DISPATCH_STARTED",
              actorId: principal.userId,
              payload: {},
            },
          });
          currentStatus = next;
        }

        const assignedStatus = this.stateMachine.transition(
          currentStatus,
          "THERAPIST_ASSIGNED",
        );
        if (order.reservationId) {
          await tx.appointmentReservation.update({
            where: { id: order.reservationId },
            data: { therapistId: input.therapistId },
          });
        }
        const assigned = await tx.order.updateMany({
          where: { id: order.id, status: currentStatus },
          data: {
            status: assignedStatus,
            therapistId: input.therapistId,
          },
        });
        if (assigned.count !== 1)
          throw new ConflictException("订单调度状态已变化");

        await tx.orderEvent.create({
          data: {
            orderId: order.id,
            type: "THERAPIST_ASSIGNED",
            actorId: principal.userId,
            payload: { therapistId: input.therapistId },
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: principal.userId,
            organizationId,
            action: "ORDER_THERAPIST_ASSIGNED",
            resourceType: "Order",
            resourceId: order.id,
            metadata: { therapistId: input.therapistId },
          },
        });
        await tx.outboxEvent.create({
          data: {
            aggregateId: order.id,
            type: "ORDER_THERAPIST_ASSIGNED",
            payload: { orderId: order.id, therapistId: input.therapistId },
          },
        });
        return {
          orderId: order.id,
          status: "ASSIGNED" as const,
          therapist: therapistMembership.user,
        };
      });
    } catch (error) {
      if (this.isReservationOverlap(error)) {
        throw new ConflictException("该技师预约时段已被占用");
      }
      throw error;
    }
  }

  private safeMoney(value: bigint) {
    const money = Number(value);
    if (!Number.isSafeInteger(money)) {
      throw new InternalServerErrorException("订单金额超出安全范围");
    }
    return money;
  }

  private isReservationOverlap(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return (
      message.includes("AppointmentReservation_no_overlap") ||
      message.includes("23P01")
    );
  }
}
