import "reflect-metadata";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { PrismaClient } from "@prisma/client";
import { TechnicianApplicationSchema } from "@zydj/contracts";
import { AccessControlService } from "../src/auth/access-control.service.js";
import { AuthCryptoService } from "../src/auth/auth-crypto.service.js";
import { TechniciansService } from "../src/technicians/technicians.service.js";

const url = new URL(process.env.DATABASE_URL || "http://invalid");
if (
  url.username !== "zydj_acceptance" ||
  !["127.0.0.1", "localhost"].includes(url.hostname) ||
  !/^\/zydj_technician_phone_acceptance_20261022_[a-f0-9]{8,32}$/.test(
    url.pathname,
  )
)
  throw new Error("Dedicated acceptance database required");
const organizationId = process.env.BOOTSTRAP_ORGANIZATION_ID;
if (!organizationId) throw new Error("Explicit fixture organization required");
const prisma = new PrismaClient();
try {
  const rows = await prisma.technicianProfile.findMany({
    where: { organizationId },
    include: {
      photos: true,
      technician: { include: { identities: true, memberships: true } },
      identityDocuments: true,
    },
  });
  assert.equal(rows.length, 5);
  for (const row of rows) {
    assert.equal(row.status, "DRAFT");
    assert.equal(row.registrationChannel, "ADMIN_PHOTO_DRAFT");
    assert.equal(row.selfRegistered, false);
    assert.equal(row.publicName, "");
    assert.equal(row.realNameEncrypted, null);
    assert.equal(row.ageRange, null);
    assert.equal(row.introduction, "");
    assert.equal(row.serviceCity, "");
    assert.deepEqual(row.serviceAreas, []);
    assert.deepEqual(row.availableTimeSlots, []);
    assert.deepEqual(row.serviceIds, []);
    assert.equal(row.identityDocuments.length, 0);
    assert.equal(row.technician.phoneEncrypted, null);
    assert.equal(row.technician.phoneVerifiedAt, null);
    assert.equal(row.technician.identities.length, 0);
    assert.equal(row.technician.memberships.length, 0);
    assert.equal(row.photos.length, 1);
    assert.ok(row.photos[0]!.content.byteLength <= 512 * 1024);
  }
  const service = new TechniciansService(
    prisma as never,
    new AccessControlService(),
    undefined,
    new AuthCryptoService(new ConfigService({
      DATA_ENCRYPTION_KEY_BASE64: randomBytes(32).toString("base64"),
      AUTH_SESSION_PEPPER: randomBytes(32).toString("hex"),
    }) as never),
  );
  const principal = {
    userId: "acceptance-operator",
    sessionId: "acceptance-session",
    displayName: "fixture",
    memberships: [{ organizationId, role: "OPERATOR" as const }],
  };
  const applications = await service.listApplications(
    principal,
    organizationId,
  );
  assert.equal(applications.length, 5);
  for (const application of applications)
    TechnicianApplicationSchema.parse(application);
  await service.getAdminProfile(
    principal,
    organizationId,
    rows[0]!.technicianId,
  );
  await service.getAdminPhoto(
    principal,
    organizationId,
    rows[0]!.technicianId,
    rows[0]!.photos[0]!.id,
  );
  await assert.rejects(() =>
    service.getPublicPhoto(rows[0]!.technicianId, rows[0]!.photos[0]!.id),
  );
  assert.equal((await service.listPublic()).length, 0);
  assert.equal(
    await prisma.auditLog.count({
      where: { organizationId, action: "TECHNICIAN_OWNER_PHOTO_DRAFT_CREATED" },
    }),
    5,
  );
  console.log(
    JSON.stringify({
      passed: true,
      privateDrafts: 5,
      photosPerDraft: 1,
      blankPersonalFields: true,
      adminReadAndPreview: true,
      publicPhotosUnavailable: true,
      noStaffAccessGranted: true,
      importsIdempotent: true,
    }),
  );
} finally {
  await prisma.$disconnect();
}
