import { ConflictException } from "@nestjs/common";
import { OrderStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { OrderStateMachine } from "./order-state-machine.js";

describe("OrderStateMachine", () => {
  const machine = new OrderStateMachine();

  it("defines the normal payment and fulfillment path", () => {
    let status = machine.transition(
      OrderStatus.PENDING_PAYMENT,
      "PAYMENT_SUCCEEDED",
    );
    status = machine.transition(status, "DISPATCH_STARTED");
    status = machine.transition(status, "THERAPIST_ASSIGNED");
    status = machine.transition(status, "THERAPIST_EN_ROUTE");
    status = machine.transition(status, "THERAPIST_ARRIVED");
    status = machine.transition(status, "SERVICE_STARTED");
    status = machine.transition(status, "SERVICE_AWAITING_CONFIRMATION");
    status = machine.transition(status, "CUSTOMER_CONFIRMED");
    expect(status).toBe(OrderStatus.COMPLETED);
  });

  it("allows a pending order to expire or be cancelled", () => {
    expect(
      machine.transition(OrderStatus.PENDING_PAYMENT, "PAYMENT_EXPIRED"),
    ).toBe(OrderStatus.CANCELLED);
    expect(
      machine.transition(OrderStatus.PENDING_PAYMENT, "CUSTOMER_CANCELLED"),
    ).toBe(OrderStatus.CANCELLED);
  });

  it("supports the refund path only from eligible paid states", () => {
    expect(machine.transition(OrderStatus.PAID, "REFUND_STARTED")).toBe(
      OrderStatus.REFUNDING,
    );
    expect(machine.transition(OrderStatus.REFUNDING, "REFUND_SUCCEEDED")).toBe(
      OrderStatus.REFUNDED,
    );
  });

  it("rejects skipped or terminal transitions", () => {
    expect(() =>
      machine.transition(OrderStatus.PENDING_PAYMENT, "SERVICE_STARTED"),
    ).toThrow(ConflictException);
    expect(() =>
      machine.transition(OrderStatus.COMPLETED, "CUSTOMER_CANCELLED"),
    ).toThrow(ConflictException);
  });
});
