import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ConflictException, ForbiddenException } from "@nestjs/common";
import { OrderStatus, SafetyIncidentStatus, UserRole } from "@prisma/client";
import type { AuthPrincipal } from "../src/auth/auth.types.js";
import { AccessControlService } from "../src/auth/access-control.service.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { SafetyService } from "../src/safety/safety.service.js";

const databaseUrl = process.env.SAFETY_TEST_DATABASE_URL;
if (!databaseUrl)
  throw Error(
    "Set SAFETY_TEST_DATABASE_URL for the isolated local safety test database",
  );
const target = new URL(databaseUrl);
if (
  !["127.0.0.1", "localhost"].includes(target.hostname) ||
  !(
    target.pathname === "/zhongyuan_safety_test" ||
    (process.env.CI === "true" && target.pathname === "/zhongyuan_daojia_test")
  )
)
  throw Error(
    "Refusing to run safety verification outside the dedicated local database",
  );

process.env.DATABASE_URL = databaseUrl;
process.env.NODE_ENV = "test";
process.env.STAFF_MFA_REQUIRED = "false";

const prisma = new PrismaService({ datasourceUrl: databaseUrl });
const safety = new SafetyService(prisma, new AccessControlService());
const prefix = `safety-${randomUUID()}`;
let organizationId: string | undefined;

function principal(
  userId: string,
  displayName: string,
  role?: UserRole,
): AuthPrincipal {
  return {
    sessionId: `${prefix}-${displayName}`,
    userId,
    displayName,
    memberships: role ? [{ organizationId: organizationId!, role }] : [],
  };
}

try {
  const organization = await prisma.organization.create({
    data: { name: prefix },
  });
  organizationId = organization.id;

  const [adminUser, customerUser, primaryUser, backupUser] = await Promise.all([
    prisma.user.create({
      data: {
        role: UserRole.ADMIN,
        displayName: `${prefix}-admin`,
        memberships: {
          create: { organizationId, role: UserRole.ADMIN },
        },
      },
    }),
    prisma.user.create({
      data: { role: UserRole.CUSTOMER, displayName: `${prefix}-customer` },
    }),
    prisma.user.create({
      data: {
        role: UserRole.SAFETY_DUTY,
        displayName: `${prefix}-primary`,
        memberships: {
          create: { organizationId, role: UserRole.SAFETY_DUTY },
        },
      },
    }),
    prisma.user.create({
      data: {
        role: UserRole.SAFETY_DUTY,
        displayName: `${prefix}-backup`,
        memberships: {
          create: { organizationId, role: UserRole.SAFETY_DUTY },
        },
      },
    }),
  ]);
  const admin = principal(adminUser.id, "admin", UserRole.ADMIN);
  const customer = principal(customerUser.id, "customer");
  const primary = principal(primaryUser.id, "primary", UserRole.SAFETY_DUTY);
  const backup = principal(backupUser.id, "backup", UserRole.SAFETY_DUTY);

  const roster = await safety.configureRoster(admin, organizationId, {
    primaryUserId: primaryUser.id,
    backupUserId: backupUser.id,
    acknowledgementTimeoutSeconds: 120,
  });
  assert.equal(roster.active, true);
  assert.equal(
    await prisma.safetyDutyRoster.count({
      where: { organizationId, active: true },
    }),
    1,
  );
  await assert.rejects(
    prisma.safetyDutyRoster.create({
      data: {
        organizationId,
        primaryUserId: primaryUser.id,
        backupUserId: primaryUser.id,
        acknowledgementTimeoutSeconds: 120,
        active: false,
        createdById: adminUser.id,
      },
    }),
  );

  const now = new Date();
  const order = await prisma.order.create({
    data: {
      orderNo: `${prefix}-order`,
      organizationId,
      customerId: customerUser.id,
      status: OrderStatus.IN_SERVICE,
      appointmentStart: now,
      appointmentEnd: new Date(now.getTime() + 60 * 60 * 1_000),
      serviceAmountFen: 19_800n,
      travelFeeFen: 0n,
      discountFen: 0n,
      payableFen: 19_800n,
      addressEncrypted: "synthetic-test-address",
      policyVersion: "safety-integration-v1",
      idempotencyKey: `${prefix}-order-key`,
      requestFingerprint: `${prefix}-order-fingerprint`,
    },
  });
  await assert.rejects(
    prisma.safetyIncident.create({
      data: {
        organizationId,
        orderId: order.id,
        reporterUserId: customerUser.id,
        rosterId: roster.id,
        primaryUserId: primaryUser.id,
        backupUserId: backupUser.id,
        category: "PERSONAL_SAFETY",
        status: SafetyIncidentStatus.CLOSED,
        idempotencyKey: `${prefix}-invalid-state`,
        requestFingerprint: "0".repeat(64),
        acknowledgementDueAt: new Date(Date.now() + 120_000),
      },
    }),
  );

  const incidentKey = `${prefix}-incident-a`;
  const simultaneous = await Promise.all([
    safety.createIncident(
      customer,
      order.id,
      { category: "PERSONAL_SAFETY" },
      incidentKey,
    ),
    safety.createIncident(
      customer,
      order.id,
      { category: "PERSONAL_SAFETY" },
      incidentKey,
    ),
  ]);
  assert.equal(simultaneous[0].data.id, simultaneous[1].data.id);
  assert.equal("primaryUserId" in simultaneous[0].data, false);
  assert.equal("backupUserId" in simultaneous[0].data, false);
  assert.deepEqual(
    simultaneous.map((result) => result.idempotentReplay).sort(),
    [false, true],
  );
  assert.equal(
    await prisma.safetyIncident.count({
      where: { reporterUserId: customerUser.id, idempotencyKey: incidentKey },
    }),
    1,
  );
  assert.equal(
    await prisma.safetyIncidentEvent.count({
      where: {
        incidentId: simultaneous[0].data.id,
        type: "SAFETY_INCIDENT_OPENED",
      },
    }),
    1,
  );
  assert.equal(
    await prisma.outboxEvent.count({
      where: {
        aggregateId: simultaneous[0].data.id,
        type: "SAFETY_INCIDENT_OPENED",
      },
    }),
    1,
  );
  await assert.rejects(
    safety.createIncident(
      customer,
      order.id,
      { category: "MEDICAL_CONCERN" },
      incidentKey,
    ),
    ConflictException,
  );
  await assert.rejects(
    safety.acknowledge(backup, organizationId, simultaneous[0].data.id),
    ForbiddenException,
  );
  const acknowledgedByPrimary = await safety.acknowledge(
    primary,
    organizationId,
    simultaneous[0].data.id,
  );
  assert.equal(acknowledgedByPrimary.status, SafetyIncidentStatus.ACKNOWLEDGED);

  const second = await safety.createIncident(
    customer,
    order.id,
    { category: "MEDICAL_CONCERN" },
    `${prefix}-incident-b`,
  );
  const overdueAt = new Date(Date.now() - 1_000);
  await prisma.safetyIncident.update({
    where: { id: second.data.id },
    data: {
      createdAt: new Date(overdueAt.getTime() - 120_000),
      acknowledgementDueAt: overdueAt,
    },
  });
  const scans = await Promise.all([
    safety.escalateDue(new Date()),
    safety.escalateDue(new Date()),
  ]);
  assert.equal(scans[0] + scans[1], 1);
  assert.equal(
    await prisma.safetyIncidentEvent.count({
      where: {
        incidentId: second.data.id,
        type: "SAFETY_INCIDENT_ESCALATED",
      },
    }),
    1,
  );
  assert.equal(
    await prisma.outboxEvent.count({
      where: {
        aggregateId: second.data.id,
        type: "SAFETY_INCIDENT_ESCALATED",
      },
    }),
    1,
  );
  await assert.rejects(
    safety.acknowledge(primary, organizationId, second.data.id),
    ForbiddenException,
  );
  const concurrentAcknowledgements = await Promise.all([
    safety.acknowledge(backup, organizationId, second.data.id),
    safety.acknowledge(backup, organizationId, second.data.id),
  ]);
  assert.equal(concurrentAcknowledgements[0].acknowledgedById, backupUser.id);
  assert.equal(concurrentAcknowledgements[1].acknowledgedById, backupUser.id);
  assert.equal(
    await prisma.safetyIncidentEvent.count({
      where: {
        incidentId: second.data.id,
        type: "SAFETY_INCIDENT_ACKNOWLEDGED",
      },
    }),
    1,
  );
  await assert.rejects(
    safety.close(primary, organizationId, second.data.id, {
      resolutionCode: "RESOLVED",
    }),
    ForbiddenException,
  );
  const closed = await safety.close(backup, organizationId, second.data.id, {
    resolutionCode: "FOLLOW_UP_REQUIRED",
  });
  assert.equal(closed.status, SafetyIncidentStatus.CLOSED);
  assert.equal(closed.resolutionCode, "FOLLOW_UP_REQUIRED");
  await assert.rejects(
    safety.close(primary, organizationId, second.data.id, {
      resolutionCode: "FOLLOW_UP_REQUIRED",
    }),
    ForbiddenException,
  );

  const actions = await prisma.auditLog.findMany({
    where: { organizationId },
    select: { action: true },
  });
  for (const required of [
    "SAFETY_DUTY_ROSTER_CONFIGURED",
    "SAFETY_INCIDENT_OPENED",
    "SAFETY_INCIDENT_ESCALATED",
    "SAFETY_INCIDENT_ACKNOWLEDGED",
    "SAFETY_INCIDENT_CLOSED",
  ])
    assert(
      actions.some((row) => row.action === required),
      `missing ${required}`,
    );

  console.log(
    JSON.stringify({
      ok: true,
      database: target.pathname.slice(1),
      checks: [
        "roster database constraints",
        "incident database state constraints",
        "concurrent incident idempotency",
        "primary-only acknowledgement window",
        "concurrent one-time escalation",
        "backup-only escalated acknowledgement",
        "acknowledger-only close",
        "audit and outbox records",
      ],
    }),
  );
} finally {
  if (organizationId) {
    const incidents = await prisma.safetyIncident.findMany({
      where: { organizationId },
      select: { id: true },
    });
    const aggregateIds = incidents.map((incident) => incident.id);
    if (aggregateIds.length)
      await prisma.outboxEvent.deleteMany({
        where: { aggregateId: { in: aggregateIds } },
      });
    await prisma.auditLog.deleteMany({ where: { organizationId } });
    await prisma.safetyIncident.deleteMany({ where: { organizationId } });
    await prisma.safetyDutyRoster.deleteMany({ where: { organizationId } });
    await prisma.order.deleteMany({ where: { organizationId } });
    await prisma.staffMembership.deleteMany({ where: { organizationId } });
    await prisma.user.deleteMany({
      where: { displayName: { startsWith: prefix } },
    });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
  }
  await prisma.$disconnect();
}
