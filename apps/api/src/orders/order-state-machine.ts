import { ConflictException, Injectable } from "@nestjs/common";
import { OrderStatus } from "@prisma/client";

export type OrderTransitionEvent =
  | "PAYMENT_SUCCEEDED"
  | "PAYMENT_EXPIRED"
  | "CUSTOMER_CANCELLED"
  | "DISPATCH_STARTED"
  | "THERAPIST_ASSIGNED"
  | "THERAPIST_EN_ROUTE"
  | "THERAPIST_ARRIVED"
  | "SERVICE_STARTED"
  | "SERVICE_AWAITING_CONFIRMATION"
  | "CUSTOMER_CONFIRMED"
  | "REFUND_STARTED"
  | "REFUND_SUCCEEDED";

const TRANSITIONS: Record<
  OrderStatus,
  Partial<Record<OrderTransitionEvent, OrderStatus>>
> = {
  PENDING_PAYMENT: {
    PAYMENT_SUCCEEDED: OrderStatus.PAID,
    PAYMENT_EXPIRED: OrderStatus.CANCELLED,
    CUSTOMER_CANCELLED: OrderStatus.CANCELLED,
  },
  PAID: {
    DISPATCH_STARTED: OrderStatus.DISPATCHING,
    REFUND_STARTED: OrderStatus.REFUNDING,
  },
  DISPATCHING: {
    THERAPIST_ASSIGNED: OrderStatus.ASSIGNED,
    REFUND_STARTED: OrderStatus.REFUNDING,
  },
  ASSIGNED: {
    THERAPIST_EN_ROUTE: OrderStatus.EN_ROUTE,
    REFUND_STARTED: OrderStatus.REFUNDING,
  },
  EN_ROUTE: {
    THERAPIST_ARRIVED: OrderStatus.ARRIVED,
    REFUND_STARTED: OrderStatus.REFUNDING,
  },
  ARRIVED: {
    SERVICE_STARTED: OrderStatus.IN_SERVICE,
    REFUND_STARTED: OrderStatus.REFUNDING,
  },
  IN_SERVICE: {
    SERVICE_AWAITING_CONFIRMATION: OrderStatus.AWAITING_CONFIRMATION,
  },
  AWAITING_CONFIRMATION: {
    CUSTOMER_CONFIRMED: OrderStatus.COMPLETED,
  },
  COMPLETED: {},
  CANCELLED: { REFUND_STARTED: OrderStatus.REFUNDING },
  REFUNDING: { REFUND_SUCCEEDED: OrderStatus.REFUNDED },
  REFUNDED: {},
};

@Injectable()
export class OrderStateMachine {
  transition(current: OrderStatus, event: OrderTransitionEvent) {
    const next = TRANSITIONS[current][event];
    if (!next) {
      throw new ConflictException(`订单状态 ${current} 不允许事件 ${event}`);
    }
    return next;
  }
}
