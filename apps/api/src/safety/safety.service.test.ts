import { ConflictException, ForbiddenException } from "@nestjs/common";
import {
  OrderStatus,
  SafetyIncidentCategory,
  SafetyIncidentStatus,
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { AccessControlService } from "../auth/access-control.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import type { PrismaService } from "../database/prisma.service.js";
import { SafetyService } from "./safety.service.js";

const organizationId = "org-safety";
const customer: AuthPrincipal = {
  sessionId: "session-customer",
  userId: "customer-1",
  displayName: "Customer",
  memberships: [],
};
const primary: AuthPrincipal = {
  sessionId: "session-primary",
  userId: "duty-primary",
  displayName: "Primary",
  memberships: [{ organizationId, role: "SAFETY_DUTY" }],
};
const backup: AuthPrincipal = {
  sessionId: "session-backup",
  userId: "duty-backup",
  displayName: "Backup",
  memberships: [{ organizationId, role: "SAFETY_DUTY" }],
};

function fixture(options?: { dueAt?: Date; status?: SafetyIncidentStatus }) {
  const events: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const outbox: Array<Record<string, unknown>> = [];
  const now = new Date("2026-10-05T03:00:00.000Z");
  const roster = {
    id: "roster-1",
    organizationId,
    primaryUserId: primary.userId,
    backupUserId: backup.userId,
    acknowledgementTimeoutSeconds: 120,
    active: true,
    createdById: "admin-1",
    createdAt: now,
    deactivatedAt: null,
  };
  let incident: any = options?.status
    ? {
        id: "incident-1",
        organizationId,
        orderId: "order-1",
        reporterUserId: customer.userId,
        rosterId: roster.id,
        primaryUserId: primary.userId,
        backupUserId: backup.userId,
        category: SafetyIncidentCategory.PERSONAL_SAFETY,
        status: options.status,
        idempotencyKey: "incident-key-1234",
        requestFingerprint: "existing-fingerprint",
        acknowledgementDueAt:
          options.dueAt ?? new Date(now.getTime() + 120_000),
        acknowledgedById: null,
        acknowledgedAt: null,
        escalatedAt: null,
        closedById: null,
        resolutionCode: null,
        closedAt: null,
        createdAt: now,
        updatedAt: now,
      }
    : null;

  const safetyIncident = {
    findFirst: vi.fn(async () =>
      incident && incident.status !== SafetyIncidentStatus.CLOSED
        ? { id: incident.id }
        : null,
    ),
    findUnique: vi.fn(async (query: any) => {
      if (!incident) return null;
      if (query.where?.id)
        return query.where.id === incident.id ? incident : null;
      const compound = query.where?.reporterUserId_idempotencyKey;
      return compound?.reporterUserId === incident.reporterUserId &&
        compound?.idempotencyKey === incident.idempotencyKey
        ? incident
        : null;
    }),
    findUniqueOrThrow: vi.fn(async () => {
      if (!incident) throw new Error("missing incident");
      return incident;
    }),
    findMany: vi.fn(async (query: any) => {
      if (!incident) return [];
      if (
        query.where?.status === SafetyIncidentStatus.OPEN &&
        (incident.status !== SafetyIncidentStatus.OPEN ||
          incident.acknowledgementDueAt.getTime() >
            query.where.acknowledgementDueAt.lte.getTime())
      )
        return [];
      return [incident];
    }),
    create: vi.fn(async (query: any) => {
      incident = {
        id: "incident-created",
        ...query.data,
        status: SafetyIncidentStatus.OPEN,
        acknowledgedById: null,
        acknowledgedAt: null,
        escalatedAt: null,
        closedById: null,
        resolutionCode: null,
        closedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      delete incident.events;
      return incident;
    }),
    updateMany: vi.fn(async (query: any) => {
      if (!incident || query.where.id !== incident.id) return { count: 0 };
      if (query.where.status && incident.status !== query.where.status)
        return { count: 0 };
      if (
        query.where.acknowledgedById === null &&
        incident.acknowledgedById !== null
      )
        return { count: 0 };
      incident = { ...incident, ...query.data, updatedAt: now };
      return { count: 1 };
    }),
    update: vi.fn(async (query: any) => {
      incident = { ...incident, ...query.data, updatedAt: now };
      return incident;
    }),
  };
  const tx: any = {
    $queryRaw: vi.fn(async () => []),
    order: {
      findUnique: vi.fn(async () => ({
        id: "order-1",
        customerId: customer.userId,
        organizationId,
        status: OrderStatus.IN_SERVICE,
      })),
    },
    organization: {
      findUnique: vi.fn(async () => ({ id: organizationId })),
    },
    staffMembership: {
      findMany: vi.fn(async () => [
        { userId: primary.userId, user: { displayName: "Primary" } },
        { userId: backup.userId, user: { displayName: "Backup" } },
      ]),
    },
    safetyDutyRoster: {
      findFirst: vi.fn(async () => roster),
      updateMany: vi.fn(async () => ({ count: 1 })),
      create: vi.fn(async (query: any) => ({
        id: "roster-created",
        ...query.data,
        active: true,
        createdAt: now,
        deactivatedAt: null,
      })),
    },
    safetyIncident,
    safetyIncidentEvent: {
      create: vi.fn(async (query: any) => {
        events.push(query.data);
        return query.data;
      }),
    },
    auditLog: {
      create: vi.fn(async (query: any) => {
        audits.push(query.data);
        return query.data;
      }),
    },
    outboxEvent: {
      create: vi.fn(async (query: any) => {
        outbox.push(query.data);
        return query.data;
      }),
    },
  };
  const prisma: any = {
    ...tx,
    staffMembership: tx.staffMembership,
    $transaction: vi.fn(async (callback: (client: any) => unknown) =>
      callback(tx),
    ),
  };
  const access = {
    assertPermission: vi.fn(),
  } as unknown as AccessControlService;
  const service = new SafetyService(prisma as PrismaService, access);
  return {
    service,
    prisma,
    access,
    roster,
    now,
    events,
    audits,
    outbox,
    get incident() {
      return incident;
    },
  };
}

describe("SafetyService", () => {
  it("configures distinct active primary and backup staff with an audit record", async () => {
    const f = fixture();
    const result = await f.service.configureRoster(
      { ...primary, userId: "admin-1" },
      organizationId,
      {
        primaryUserId: primary.userId,
        backupUserId: backup.userId,
        acknowledgementTimeoutSeconds: 120,
      },
    );
    expect(result.primaryUserId).toBe(primary.userId);
    expect(result.backupUserId).toBe(backup.userId);
    expect(f.access.assertPermission).toHaveBeenCalledWith(
      expect.anything(),
      "iam.manage",
      organizationId,
    );
    expect(f.audits[0]?.action).toBe("SAFETY_DUTY_ROSTER_CONFIGURED");
  });

  it("lists only server-selected eligible responders for organization admins", async () => {
    const f = fixture();
    await expect(
      f.service.listEligibleResponders(
        { ...primary, userId: "admin-1" },
        organizationId,
      ),
    ).resolves.toEqual([
      { userId: primary.userId, displayName: "Primary" },
      { userId: backup.userId, displayName: "Backup" },
    ]);
    expect(f.access.assertPermission).toHaveBeenCalledWith(
      expect.anything(),
      "iam.manage",
      organizationId,
    );
  });

  it("creates one idempotent incident with event, audit and primary outbox", async () => {
    const f = fixture();
    const first = await f.service.createIncident(
      customer,
      "order-1",
      { category: "PERSONAL_SAFETY" },
      "incident-key-1234",
    );
    const second = await f.service.createIncident(
      customer,
      "order-1",
      { category: "PERSONAL_SAFETY" },
      "incident-key-1234",
    );
    expect(first.idempotentReplay).toBe(false);
    expect(second.idempotentReplay).toBe(true);
    expect(first.data).not.toHaveProperty("primaryUserId");
    expect(first.data).not.toHaveProperty("backupUserId");
    expect(f.outbox).toHaveLength(1);
    expect(f.outbox[0]).toMatchObject({ type: "SAFETY_INCIDENT_OPENED" });
    expect(f.audits[0]?.action).toBe("SAFETY_INCIDENT_OPENED");
  });

  it("rejects an idempotency key reused for a different incident request", async () => {
    const f = fixture();
    await f.service.createIncident(
      customer,
      "order-1",
      { category: "PERSONAL_SAFETY" },
      "incident-key-1234",
    );
    await expect(
      f.service.createIncident(
        customer,
        "order-1",
        { category: "MEDICAL_CONCERN" },
        "incident-key-1234",
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("allows only the primary responder before the deadline", async () => {
    const f = fixture({
      status: SafetyIncidentStatus.OPEN,
      dueAt: new Date("2026-10-05T03:02:00.000Z"),
    });
    await expect(
      f.service.acknowledge(backup, organizationId, f.incident.id, f.now),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const result = await f.service.acknowledge(
      primary,
      organizationId,
      f.incident.id,
      f.now,
    );
    expect(result.status).toBe("ACKNOWLEDGED");
    expect(result.acknowledgedById).toBe(primary.userId);
    expect(f.events.at(-1)?.type).toBe("SAFETY_INCIDENT_ACKNOWLEDGED");
  });

  it("atomically escalates a missed primary deadline and permits only backup acknowledgement", async () => {
    const f = fixture({
      status: SafetyIncidentStatus.OPEN,
      dueAt: new Date("2026-10-05T02:59:00.000Z"),
    });
    const result = await f.service.acknowledge(
      backup,
      organizationId,
      f.incident.id,
      f.now,
    );
    expect(result.status).toBe("ACKNOWLEDGED");
    expect(result.escalatedAt).toBe(f.now.toISOString());
    expect(f.events.map((event) => event.type)).toEqual([
      "SAFETY_INCIDENT_ESCALATED",
      "SAFETY_INCIDENT_ACKNOWLEDGED",
    ]);
    expect(f.outbox.map((event) => event.type)).toEqual([
      "SAFETY_INCIDENT_ESCALATED",
      "SAFETY_INCIDENT_ACKNOWLEDGED",
    ]);
  });

  it("escalates each due incident only once across repeated worker scans", async () => {
    const f = fixture({
      status: SafetyIncidentStatus.OPEN,
      dueAt: new Date("2026-10-05T02:59:00.000Z"),
    });
    expect(await f.service.escalateDue(f.now)).toBe(1);
    expect(await f.service.escalateDue(f.now)).toBe(0);
    expect(
      f.events.filter((event) => event.type === "SAFETY_INCIDENT_ESCALATED"),
    ).toHaveLength(1);
    expect(
      f.outbox.filter((event) => event.type === "SAFETY_INCIDENT_ESCALATED"),
    ).toHaveLength(1);
  });

  it("allows only the acknowledging responder to close with a fixed resolution code", async () => {
    const f = fixture({ status: SafetyIncidentStatus.ACKNOWLEDGED });
    f.incident.acknowledgedById = primary.userId;
    f.incident.acknowledgedAt = f.now;
    await expect(
      f.service.close(backup, organizationId, f.incident.id, {
        resolutionCode: "RESOLVED",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const result = await f.service.close(
      primary,
      organizationId,
      f.incident.id,
      { resolutionCode: "FOLLOW_UP_REQUIRED" },
      f.now,
    );
    expect(result.status).toBe("CLOSED");
    expect(result.resolutionCode).toBe("FOLLOW_UP_REQUIRED");
    expect(f.outbox.at(-1)?.type).toBe("SAFETY_INCIDENT_CLOSED");
    await expect(
      f.service.close(backup, organizationId, f.incident.id, {
        resolutionCode: "FOLLOW_UP_REQUIRED",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(
      await f.service.close(primary, organizationId, f.incident.id, {
        resolutionCode: "FOLLOW_UP_REQUIRED",
      }),
    ).toEqual(result);
  });
});
