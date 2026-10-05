import {
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import {
  OrderStatus,
  PaymentProvider,
  PaymentStatus,
  Prisma,
  ReservationStatus,
} from "@prisma/client";
import type {
  OrderCreate,
  OrderQuote,
  OrderView,
  ServiceAddress,
} from "@zydj/contracts";
import { createHash, randomBytes } from "node:crypto";
import { AuthCryptoService } from "../auth/auth-crypto.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { PrismaService } from "../database/prisma.service.js";
import { LocationsService } from "../locations/locations.service.js";
import { OrderStateMachine } from "./order-state-machine.js";

const PAYMENT_WINDOW_MS = 15 * 60 * 1_000;
const POLICY_VERSION = "2026-10-03.dev-v1";

type OrderWithItems = Prisma.OrderGetPayload<{ include: { items: true } }>;

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: AuthCryptoService,
    private readonly stateMachine: OrderStateMachine,
    private readonly locations: LocationsService,
  ) {}

  async quote(
    principal: AuthPrincipal,
    reservationId: string,
  ): Promise<OrderQuote> {
    const reservation = await this.prisma.appointmentReservation.findUnique({
      where: { id: reservationId },
    });
    this.assertOwnedReservation(principal, reservation);
    if (reservation.status !== ReservationStatus.HOLD) {
      throw new ConflictException("预约占位已结束");
    }
    if (reservation.expiresAt.getTime() <= Date.now()) {
      await this.prisma.appointmentReservation.updateMany({
        where: { id: reservation.id, status: ReservationStatus.HOLD },
        data: { status: ReservationStatus.EXPIRED },
      });
      throw new ConflictException("预约占位已过期");
    }
    const serviceAmountFen = this.safeMoney(reservation.serviceAmountFen);
    return {
      reservationId: reservation.id,
      serviceAmountFen,
      travelFeeFen: 0,
      discountFen: 0,
      payableFen: serviceAmountFen,
      currency: "CNY",
      moneyUnit: "fen",
    };
  }

  async create(
    principal: AuthPrincipal,
    input: OrderCreate,
    idempotencyKey: string,
  ) {
    const requestFingerprint = this.fingerprint(input);
    const existing = await this.findByIdempotency(
      principal.userId,
      idempotencyKey,
    );
    if (existing) return this.replay(existing, requestFingerprint);

    const now = new Date();
    const paymentExpiresAt = new Date(now.getTime() + PAYMENT_WINDOW_MS);
    const addressEncrypted = this.crypto.encrypt(
      this.serializeAddress(input.address),
    );

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const reservation = await tx.appointmentReservation.findUnique({
          where: { id: input.reservationId },
          include: { service: true, order: true },
        });
        this.assertOwnedReservation(principal, reservation);
        if (reservation.order)
          throw new ConflictException("预约占位已经生成订单");
        if (
          reservation.status !== ReservationStatus.HOLD ||
          reservation.expiresAt.getTime() <= now.getTime()
        ) {
          if (reservation.status === ReservationStatus.HOLD) {
            await tx.appointmentReservation.updateMany({
              where: { id: reservation.id, status: ReservationStatus.HOLD },
              data: { status: ReservationStatus.EXPIRED },
            });
          }
          return null;
        }

        await this.locations.assertOrderVerification(tx, principal, input, now);

        const locked = await tx.appointmentReservation.updateMany({
          where: {
            id: reservation.id,
            customerId: principal.userId,
            status: ReservationStatus.HOLD,
            expiresAt: { gt: now },
            order: { is: null },
          },
          data: { expiresAt: paymentExpiresAt },
        });
        if (locked.count !== 1)
          throw new ConflictException("预约占位状态已变化");

        const serviceAmountFen = reservation.serviceAmountFen;
        const travelFeeFen = 0n;
        const discountFen = 0n;
        const payableFen = serviceAmountFen + travelFeeFen - discountFen;
        const order = await tx.order.create({
          data: {
            orderNo: this.createOrderNo(),
            organizationId: reservation.organizationId,
            customerId: principal.userId,
            therapistId: reservation.therapistId,
            reservationId: reservation.id,
            status: OrderStatus.PENDING_PAYMENT,
            appointmentStart: reservation.startsAt,
            appointmentEnd: reservation.endsAt,
            serviceAmountFen,
            travelFeeFen,
            discountFen,
            payableFen,
            addressEncrypted,
            policyVersion: POLICY_VERSION,
            paymentExpiresAt,
            idempotencyKey,
            requestFingerprint,
            items: {
              create: {
                serviceId: reservation.serviceId,
                serviceName: reservation.service.name,
                durationMinutes: reservation.service.durationMinutes,
                unitPriceFen: serviceAmountFen,
              },
            },
            events: {
              create: {
                type: "ORDER_CREATED",
                actorId: principal.userId,
                payload: { reservationId: reservation.id },
              },
            },
          },
          include: { items: true },
        });
        await tx.auditLog.create({
          data: {
            actorId: principal.userId,
            organizationId: reservation.organizationId,
            action: "ORDER_CREATED",
            resourceType: "Order",
            resourceId: order.id,
            metadata: { orderNo: order.orderNo },
          },
        });
        await tx.outboxEvent.create({
          data: {
            aggregateId: order.id,
            type: "ORDER_CREATED",
            payload: {
              orderId: order.id,
              organizationId: order.organizationId,
            },
          },
        });
        return order;
      });

      if (!result) throw new ConflictException("预约占位已过期");
      return { data: this.toView(result), idempotentReplay: false };
    } catch (error) {
      const replay = await this.findByIdempotency(
        principal.userId,
        idempotencyKey,
      );
      if (replay) return this.replay(replay, requestFingerprint);
      const reservationOrder = await this.prisma.order.findUnique({
        where: { reservationId: input.reservationId },
        include: { items: true },
      });
      if (reservationOrder) throw new ConflictException("预约占位已经生成订单");
      throw error;
    }
  }

  async listOwn(principal: AuthPrincipal) {
    const orders = await this.prisma.order.findMany({
      where: { customerId: principal.userId },
      include: { items: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return orders.map((order) => this.toView(order));
  }

  async getOwn(principal: AuthPrincipal, id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!order) throw new NotFoundException("订单不存在");
    if (order.customerId !== principal.userId) {
      throw new ForbiddenException("不能查看其他用户的订单");
    }
    return this.toView(order);
  }

  async cancelOwn(principal: AuthPrincipal, id: string) {
    const current = await this.prisma.order.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!current) throw new NotFoundException("订单不存在");
    if (current.customerId !== principal.userId) {
      throw new ForbiddenException("不能取消其他用户的订单");
    }
    if (current.status === OrderStatus.CANCELLED) return this.toView(current);
    const next = this.stateMachine.transition(
      current.status,
      "CUSTOMER_CANCELLED",
    );

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${id} FOR UPDATE`;
      const locked = await tx.order.findUniqueOrThrow({
        where: { id },
        include: { items: true, payment: true },
      });
      if (locked.status === OrderStatus.CANCELLED) return locked;
      if (locked.status !== current.status)
        throw new ConflictException("订单状态已变化");
      if (
        locked.payment?.provider === PaymentProvider.WECHAT &&
        locked.payment.status === PaymentStatus.PENDING
      )
        throw new ConflictException(
          "微信支付原单尚未确认关闭，请先查单并联系人工处理；不能直接释放预约",
        );
      const result = await tx.order.updateMany({
        where: { id, customerId: principal.userId, status: current.status },
        data: { status: next },
      });
      if (result.count !== 1) throw new ConflictException("订单状态已变化");
      if (current.reservationId) {
        await tx.appointmentReservation.updateMany({
          where: { id: current.reservationId, status: ReservationStatus.HOLD },
          data: { status: ReservationStatus.RELEASED },
        });
      }
      await tx.orderEvent.create({
        data: {
          orderId: id,
          type: "CUSTOMER_CANCELLED",
          actorId: principal.userId,
          payload: {},
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: principal.userId,
          organizationId: current.organizationId,
          action: "ORDER_CANCELLED",
          resourceType: "Order",
          resourceId: id,
          metadata: {},
        },
      });
      await tx.outboxEvent.create({
        data: {
          aggregateId: id,
          type: "ORDER_CANCELLED",
          payload: { orderId: id },
        },
      });
      return tx.order.findUniqueOrThrow({
        where: { id },
        include: { items: true },
      });
    });
    return this.toView(updated);
  }

  private async findByIdempotency(customerId: string, idempotencyKey: string) {
    return this.prisma.order.findUnique({
      where: { customerId_idempotencyKey: { customerId, idempotencyKey } },
      include: { items: true },
    });
  }

  private replay(order: OrderWithItems, requestFingerprint: string) {
    if (order.requestFingerprint !== requestFingerprint) {
      throw new ConflictException("幂等键已用于不同的下单请求");
    }
    return { data: this.toView(order), idempotentReplay: true };
  }

  private assertOwnedReservation(
    principal: AuthPrincipal,
    reservation: {
      id: string;
      customerId: string;
      status: ReservationStatus;
      expiresAt: Date;
      serviceAmountFen: bigint;
    } | null,
  ): asserts reservation is NonNullable<typeof reservation> {
    if (!reservation) throw new NotFoundException("预约占位不存在");
    if (reservation.customerId !== principal.userId) {
      throw new ForbiddenException("不能使用其他用户的预约占位");
    }
  }

  private fingerprint(input: OrderCreate) {
    return createHash("sha256").update(JSON.stringify(input)).digest("hex");
  }

  private serializeAddress(address: ServiceAddress) {
    return JSON.stringify({
      contactName: address.contactName,
      phone: address.phone,
      detail: address.detail,
    });
  }

  private createOrderNo() {
    const shanghai = new Date(Date.now() + 8 * 60 * 60 * 1_000);
    const date = [
      shanghai.getUTCFullYear(),
      String(shanghai.getUTCMonth() + 1).padStart(2, "0"),
      String(shanghai.getUTCDate()).padStart(2, "0"),
    ].join("");
    return `ZY${date}${randomBytes(4).toString("hex").toUpperCase()}`;
  }

  private safeMoney(value: bigint) {
    const money = Number(value);
    if (!Number.isSafeInteger(money)) {
      throw new InternalServerErrorException("订单金额超出安全序列化范围");
    }
    return money;
  }

  private toView(order: OrderWithItems): OrderView {
    const item = order.items[0];
    if (!item || !order.reservationId) {
      throw new InternalServerErrorException("订单快照资料不完整");
    }
    return {
      id: order.id,
      orderNo: order.orderNo,
      reservationId: order.reservationId,
      status: order.status,
      serviceName: item.serviceName,
      appointmentStart: order.appointmentStart.toISOString(),
      appointmentEnd: order.appointmentEnd.toISOString(),
      serviceAmountFen: this.safeMoney(order.serviceAmountFen),
      travelFeeFen: this.safeMoney(order.travelFeeFen),
      discountFen: this.safeMoney(order.discountFen),
      payableFen: this.safeMoney(order.payableFen),
      paymentExpiresAt: order.paymentExpiresAt?.toISOString() ?? null,
      createdAt: order.createdAt.toISOString(),
    };
  }
}
