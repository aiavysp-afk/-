import { describe, expect, it, vi } from "vitest";
import type { AccessControlService } from "../auth/access-control.service.js";
import type { AuthCryptoService } from "../auth/auth-crypto.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import type { PrismaService } from "../database/prisma.service.js";
import { SafetyNotificationService } from "./safety-notification.service.js";

const principal = {
  userId: "admin-1",
  sessionId: "session-1",
  displayName: "Admin",
  memberships: [],
} satisfies AuthPrincipal;

describe("SafetyNotificationService monitoring", () => {
  it("flags old dispatch, dead-letter and failed delivery without exposing channel ids", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        createdAt: new Date("2026-10-05T00:00:00.000Z"),
        publishedAt: null,
        deadLetteredAt: null,
        deliveryStatus: null,
      },
      {
        createdAt: new Date("2026-10-05T00:01:00.000Z"),
        publishedAt: null,
        deadLetteredAt: new Date("2026-10-05T00:02:00.000Z"),
        deliveryStatus: null,
      },
      {
        createdAt: new Date("2026-10-05T00:03:00.000Z"),
        publishedAt: new Date("2026-10-05T00:04:00.000Z"),
        deadLetteredAt: null,
        deliveryStatus: "FAILED",
      },
      {
        createdAt: new Date("2026-10-05T00:05:00.000Z"),
        publishedAt: new Date("2026-10-05T00:06:00.000Z"),
        deadLetteredAt: null,
        deliveryStatus: "DELIVERED",
      },
    ]);
    const service = new SafetyNotificationService(
      { outboxEvent: { findMany } } as unknown as PrismaService,
      { assertPermission: vi.fn() } as unknown as AccessControlService,
      {} as AuthCryptoService,
    );
    await expect(
      service.summary(principal, "org-1", new Date("2026-10-05T00:20:00.000Z")),
    ).resolves.toEqual({
      dispatchPending: 1,
      deadLetter: 1,
      awaitingReceipt: 0,
      delivered: 1,
      deliveryFailed: 1,
      deliveryUnknown: 0,
      oldestAttentionAt: "2026-10-05T00:00:00.000Z",
      attentionRequired: true,
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: "org-1",
          type: {
            in: ["SAFETY_INCIDENT_OPENED", "SAFETY_INCIDENT_ESCALATED"],
          },
        },
      }),
    );
  });

  it("does not alert on a recent dispatch or recent pending receipt", async () => {
    const service = new SafetyNotificationService(
      {
        outboxEvent: {
          findMany: vi.fn().mockResolvedValue([
            {
              createdAt: new Date("2026-10-05T00:19:00.000Z"),
              publishedAt: null,
              deadLetteredAt: null,
              deliveryStatus: null,
            },
            {
              createdAt: new Date("2026-10-05T00:18:00.000Z"),
              publishedAt: new Date("2026-10-05T00:19:00.000Z"),
              deadLetteredAt: null,
              deliveryStatus: "PENDING",
            },
          ]),
        },
      } as unknown as PrismaService,
      { assertPermission: vi.fn() } as unknown as AccessControlService,
      {} as AuthCryptoService,
    );
    const result = await service.summary(
      principal,
      "org-1",
      new Date("2026-10-05T00:20:00.000Z"),
    );
    expect(result).toMatchObject({
      dispatchPending: 1,
      awaitingReceipt: 1,
      attentionRequired: false,
      oldestAttentionAt: null,
    });
  });
});
