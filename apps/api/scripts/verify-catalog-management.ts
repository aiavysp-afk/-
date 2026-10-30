import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { PrismaClient } from "@prisma/client";
import { AccessControlService } from "../src/auth/access-control.service.js";
import type { AuthPrincipal } from "../src/auth/auth.types.js";
import { CatalogService } from "../src/catalog/catalog.service.js";

// Deliberately no DATABASE_URL fallback or dotenv: never run against live data.
const raw = process.env.CATALOG_MANAGEMENT_TEST_DATABASE_URL;
if (!raw) throw Error("Explicit disposable catalog database required");
const url = new URL(raw);
if (
  !["localhost", "127.0.0.1"].includes(url.hostname) ||
  url.username !== "zydj_acceptance" ||
  !/^\/zydj_catalog_acceptance_[a-f0-9]{16}$/.test(url.pathname)
)
  throw Error("Refusing non-disposable catalog database");
const prisma = new PrismaClient({ datasourceUrl: raw });
const access = new AccessControlService(
  new ConfigService({
    NODE_ENV: "production",
    STAFF_MFA_REQUIRED: "true",
  }),
);
const catalog = new CatalogService(prisma as never, access);
try {
  const org = await prisma.organization.create({
    data: { name: "isolated catalog" },
  });
  const foreign = await prisma.organization.create({
    data: { name: "foreign isolated" },
  });
  const actor = await prisma.user.create({
    data: {
      role: "OPERATOR",
      displayName: "Isolated operator",
      organizationId: org.id,
    },
  });
  const principal: AuthPrincipal = {
    userId: actor.id,
    sessionId: "isolated-no-real-session",
    displayName: "Fixture",
    mfaVerifiedUntil: new Date(Date.now() + 300000),
    memberships: [{ organizationId: org.id, role: "OPERATOR" }],
  };
  const draft = () => ({
    clientRequestId: randomUUID(),
    organizationId: org.id,
    name: "隔离验收项目",
    category: "MASSAGE" as const,
    subtitle: "隔离项目简介",
    description: "仅用于隔离数据库的项目管理验收说明",
    durationMinutes: 60,
    priceFen: 21800,
    featured: false,
    steps: ["预约确认", "服务结束"],
    boundaries: ["非医疗服务"],
  });
  const input = draft();
  const created = await catalog.create(principal, input);
  assert.equal(created.published, false);
  assert.equal((await catalog.listPublished()).length, 0);
  assert.equal((await catalog.create(principal, input)).id, created.id);
  assert.equal(await prisma.service.count(), 1);
  await assert.rejects(() =>
    catalog.create(principal, { ...draft(), organizationId: foreign.id }),
  );
  await assert.rejects(() =>
    catalog.update(
      {
        ...principal,
        memberships: [{ organizationId: foreign.id, role: "OPERATOR" }],
      },
      created.id,
      { priceFen: 1 },
    ),
  );
  let current = await catalog.setPublished(principal, created.id, true);
  assert.equal((await catalog.getPublished(current.slug)).priceFen, 21800);
  await assert.rejects(() =>
    catalog.remove(principal, current.id, {
      expectedUpdatedAt: current.updatedAt,
    }),
  );
  const snapshot = current.updatedAt;
  const concurrent = await Promise.allSettled([
    catalog.update(principal, current.id, {
      expectedUpdatedAt: snapshot,
      priceFen: 25800,
    }),
    catalog.update(principal, current.id, {
      expectedUpdatedAt: snapshot,
      priceFen: 26800,
    }),
  ]);
  assert.equal(
    concurrent.filter((row) => row.status === "fulfilled").length,
    1,
  );
  assert.equal(concurrent.filter((row) => row.status === "rejected").length, 1);
  current = (await catalog.listForAdmin(principal, org.id))[0]!;
  assert.ok(
    [25800, 26800].includes(
      (await catalog.getPublished(current.slug)).priceFen,
    ),
  );
  assert.notEqual(current.updatedAt, snapshot);
  await assert.rejects(() =>
    catalog.remove(principal, current.id, { expectedUpdatedAt: snapshot }),
  );
  current = await catalog.setPublished(principal, current.id, false);
  await assert.rejects(() => catalog.getPublished(current.slug));
  assert.equal((await catalog.listPublished()).length, 0);
  assert.deepEqual(
    await catalog.remove(principal, current.id, {
      expectedUpdatedAt: current.updatedAt,
    }),
    { id: current.id, deleted: true },
  );
  await assert.rejects(() => catalog.create(principal, input));
  assert.equal(await prisma.service.count({ where: { id: current.id } }), 0);

  const historical = await catalog.create(principal, draft());
  const customer = await prisma.user.create({
    data: { role: "CUSTOMER", displayName: "Isolated customer" },
  });
  const therapist = await prisma.user.create({
    data: {
      role: "THERAPIST",
      displayName: "Isolated therapist",
      organizationId: org.id,
    },
  });
  await prisma.appointmentReservation.create({
    data: {
      organizationId: org.id,
      serviceId: historical.id,
      therapistId: therapist.id,
      customerId: customer.id,
      startsAt: new Date(Date.now() - 7200000),
      endsAt: new Date(Date.now() - 3600000),
      expiresAt: new Date(Date.now() - 7200000),
      createdAt: new Date(Date.now() - 10800000),
      status: "EXPIRED",
      serviceAmountFen: 21800n,
    },
  });
  await assert.rejects(() =>
    catalog.remove(principal, historical.id, {
      expectedUpdatedAt: historical.updatedAt,
    }),
  );
  assert.equal(
    await prisma.appointmentReservation.count({
      where: { serviceId: historical.id },
    }),
    1,
  );
  const skill = await catalog.create(principal, draft());
  await prisma.technicianProfile.create({
    data: {
      organizationId: org.id,
      technicianId: therapist.id,
      serviceIds: [skill.id],
    },
  });
  await assert.rejects(() =>
    catalog.remove(principal, skill.id, { expectedUpdatedAt: skill.updatedAt }),
  );
  assert.equal(
    await prisma.auditLog.count({
      where: { action: "CATALOG_SERVICE_CREATED" },
    }),
    3,
  );
  assert.equal(
    await prisma.auditLog.count({
      where: { action: "CATALOG_SERVICE_DELETED" },
    }),
    1,
  );
  console.log(
    JSON.stringify({
      passed: true,
      createUnpublished: true,
      idempotentCreate: true,
      crossOrganizationRejected: true,
      publishReadUpdateSync: true,
      concurrentEditCAS: true,
      unpublishRevokesCatalog: true,
      deleteDraft: true,
      deletedRequestCannotRecreate: true,
      historicalReservationPreserved: true,
      technicianSkillPreserved: true,
      auditsVerified: true,
    }),
  );
} finally {
  await prisma.$disconnect();
}
