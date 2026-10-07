import { OrderStatus, UserRole } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { OrderStateMachine } from "./order-state-machine.js";
import { OrdersService } from "./orders.service.js";
import { TechnicianWorkbenchService } from "./technician-workbench.service.js";

const therapist: AuthPrincipal = {
  sessionId: "session-tech",
  userId: "tech-1",
  displayName: "安然",
  memberships: [{ organizationId: "org-1", role: UserRole.THERAPIST }],
};

describe("GCJ-02 technician location flow", () => {
  it("reports a technician location and calculates an assigned-order route", async () => {
    const now = new Date("2026-10-07T12:00:00.000Z");
    const prisma = {
      technicianLocation: {
        upsert: vi
          .fn()
          .mockImplementation(({ create }) => Promise.resolve(create)),
        findUnique: vi.fn().mockResolvedValue({
          latitude: 34.75,
          longitude: 113.65,
          coordinateSystem: "GCJ-02",
          accuracyMeters: 12,
          reportedAt: now,
        }),
      },
      order: {
        findUnique: vi.fn().mockResolvedValue({
          id: "order-1",
          organizationId: "org-1",
          therapistId: therapist.userId,
          status: OrderStatus.ASSIGNED,
          addressEncrypted: "encrypted-address",
          addressLatitude: 34.8,
          addressLongitude: 113.7,
          addressCoordinateSystem: "GCJ-02",
        }),
      },
      mapRequestRateLimit: {
        upsert: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const access = { assertPermission: vi.fn() };
    const maps = {
      driving: vi.fn().mockResolvedValue({
        distanceMeters: 6200,
        durationSeconds: 960,
      }),
    };
    const crypto = {
      decrypt: vi
        .fn()
        .mockReturnValue(JSON.stringify({ detail: "郑州市中原区测试路 1 号" })),
    };
    const service = new TechnicianWorkbenchService(
      prisma as never,
      access as never,
      new OrderStateMachine(),
      maps as never,
      crypto as never,
    );

    await expect(
      service.reportLocation(
        therapist,
        {
          latitude: 34.75,
          longitude: 113.65,
          coordinateSystem: "GCJ-02",
          accuracyMeters: 12,
        },
        now,
      ),
    ).resolves.toMatchObject({
      coordinateSystem: "GCJ-02",
      accuracyMeters: 12,
    });

    await expect(
      service.route(therapist, "order-1", now),
    ).resolves.toMatchObject({
      orderId: "order-1",
      distanceMeters: 6200,
      durationSeconds: 960,
      destination: {
        latitude: 34.8,
        longitude: 113.7,
        coordinateSystem: "GCJ-02",
      },
    });
    expect(maps.driving).toHaveBeenCalledOnce();
    expect(access.assertPermission).toHaveBeenCalledWith(
      therapist,
      "orders.read",
      "org-1",
    );
  });

  it("shows a fresh en-route technician location only to the owning customer", async () => {
    const customer: AuthPrincipal = {
      sessionId: "session-customer",
      userId: "customer-1",
      displayName: "客户",
      memberships: [],
    };
    const reportedAt = new Date("2026-10-07T12:00:00.000Z");
    const prisma = {
      order: {
        findUnique: vi.fn().mockResolvedValue({
          id: "order-1",
          customerId: customer.userId,
          therapistId: therapist.userId,
          status: OrderStatus.EN_ROUTE,
          therapist: {
            technicianLocation: {
              latitude: 34.75,
              longitude: 113.65,
              accuracyMeters: 8,
              reportedAt,
            },
          },
        }),
      },
    };
    const service = new OrdersService(
      prisma as never,
      {} as never,
      new OrderStateMachine(),
      {} as never,
    );
    await expect(
      service.getTechnicianLocation(
        customer,
        "order-1",
        new Date("2026-10-07T12:03:00.000Z"),
      ),
    ).resolves.toMatchObject({
      status: "AVAILABLE",
      location: { coordinateSystem: "GCJ-02", accuracyMeters: 8 },
    });
  });
});
